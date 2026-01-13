#!/usr/bin/env python3
"""
H5P Integration Example - FastAPI (Single File)
================================================
A minimal FastAPI app demonstrating H5P content creation, playback, and scoring.

Requirements:
    pip install fastapi uvicorn aiosqlite

Run:
    uvicorn app:app --reload --port 5000

Then open http://localhost:5000 in your browser.
Make sure the H5P server is running at http://localhost:3000
"""

import aiosqlite
from contextlib import asynccontextmanager
from typing import Optional
from pydantic import BaseModel
from fastapi import FastAPI, Request, Query
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse

# Configuration
H5P_SERVER = 'http://localhost:3000'
APP_URL = 'http://localhost:5000'
DATABASE = 'h5p_data.db'

# ============================================================================
# Pydantic Models
# ============================================================================

class XAPIScore(BaseModel):
    raw: float = 0
    max: float = 100

class XAPIResult(BaseModel):
    score: Optional[XAPIScore] = None
    completion: bool = False
    success: bool = False

class XAPIVerb(BaseModel):
    id: str = ""

class XAPIStatement(BaseModel):
    verb: Optional[XAPIVerb] = None
    result: Optional[XAPIResult] = None

class WebhookPayload(BaseModel):
    contentId: str
    userId: str = "anonymous"
    statement: Optional[XAPIStatement] = None

# ============================================================================
# Database Setup
# ============================================================================

async def init_db():
    """Initialize database tables."""
    async with aiosqlite.connect(DATABASE) as db:
        await db.execute('''
            CREATE TABLE IF NOT EXISTS h5p_content (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                h5p_id TEXT UNIQUE NOT NULL,
                title TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        await db.execute('''
            CREATE TABLE IF NOT EXISTS h5p_grades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_id INTEGER REFERENCES h5p_content(id),
                user_id TEXT NOT NULL,
                score REAL,
                max_score REAL,
                completed BOOLEAN DEFAULT FALSE,
                xapi_verb TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        await db.commit()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup."""
    await init_db()
    print(f'''
    H5P FastAPI Example
    ===================
    App running at: {APP_URL}
    H5P Server:     {H5P_SERVER}

    Make sure the H5P server is running!
    ''')
    yield

app = FastAPI(title="H5P Integration - FastAPI Example", lifespan=lifespan)

# ============================================================================
# Routes
# ============================================================================

@app.get("/", response_class=HTMLResponse)
async def home():
    """Home page - list all H5P content with play/edit links."""
    async with aiosqlite.connect(DATABASE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute('SELECT * FROM h5p_content ORDER BY created_at DESC') as cursor:
            content_list = await cursor.fetchall()

    items_html = ""
    if content_list:
        for item in content_list:
            items_html += f'''
            <li class="content-item">
                <span class="content-title">{item['title'] or 'Untitled'}</span>
                <span class="actions">
                    <a href="/play/{item['h5p_id']}">Play</a>
                    <a href="/edit/{item['h5p_id']}" class="edit" onclick="openEditor('{item['h5p_id']}'); return false;">Edit</a>
                    <a href="/grades/{item['id']}" class="grades">Grades</a>
                </span>
            </li>
            '''
    else:
        items_html = '<li class="empty">No content yet. Create your first H5P activity!</li>'

    return f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>H5P Integration - FastAPI Example</title>
        <style>
            body {{ font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }}
            h1 {{ color: #333; }}
            .content-list {{ list-style: none; padding: 0; }}
            .content-item {{ padding: 15px; margin: 10px 0; background: #f5f5f5; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }}
            .content-title {{ font-weight: bold; }}
            .actions a {{ margin-left: 10px; padding: 8px 16px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; }}
            .actions a.edit {{ background: #6c757d; }}
            .actions a.grades {{ background: #28a745; }}
            .btn-create {{ display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; margin-bottom: 20px; }}
            .empty {{ color: #666; font-style: italic; }}
        </style>
    </head>
    <body>
        <h1>H5P Content Library</h1>
        <a href="/create" class="btn-create" onclick="openEditor(); return false;">+ Create New Content</a>
        <ul class="content-list">{items_html}</ul>
        <script>
            function openEditor(contentId) {{
                const returnUrl = encodeURIComponent('{APP_URL}/callback');
                const url = contentId
                    ? '{H5P_SERVER}/edit/' + contentId + '?returnUrl=' + returnUrl
                    : '{H5P_SERVER}/new?returnUrl=' + returnUrl;
                window.open(url, 'h5p-editor', 'width=1200,height=800');
            }}
            window.addEventListener('focus', () => setTimeout(() => location.reload(), 500));
        </script>
    </body>
    </html>
    '''

@app.get("/create")
async def create():
    """Redirect to H5P editor for new content."""
    return_url = f'{APP_URL}/callback'
    return RedirectResponse(f'{H5P_SERVER}/new?returnUrl={return_url}')

@app.get("/callback", response_class=HTMLResponse)
async def callback(contentId: Optional[str] = None, title: str = "Untitled"):
    """Callback from H5P editor after content is saved."""
    if contentId:
        async with aiosqlite.connect(DATABASE) as db:
            await db.execute('''
                INSERT INTO h5p_content (h5p_id, title) VALUES (?, ?)
                ON CONFLICT(h5p_id) DO UPDATE SET title = excluded.title
            ''', (contentId, title))
            await db.commit()

    return '''
    <!DOCTYPE html>
    <html>
    <head><title>Saved</title></head>
    <body>
        <p>Content saved! This window will close...</p>
        <script>
            if (window.opener) window.opener.location.reload();
            window.close();
        </script>
    </body>
    </html>
    '''

@app.get("/play/{h5p_id}", response_class=HTMLResponse)
async def play(h5p_id: str, user: str = "demo-user"):
    """Play H5P content in an iframe."""
    return f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Play H5P Content</title>
        <style>
            body {{ font-family: system-ui, sans-serif; margin: 0; padding: 20px; }}
            h1 {{ color: #333; margin-bottom: 10px; }}
            .back {{ margin-bottom: 20px; display: inline-block; }}
            iframe {{ width: 100%; height: 600px; border: 1px solid #ddd; border-radius: 8px; }}
        </style>
    </head>
    <body>
        <a href="/" class="back">&larr; Back to Library</a>
        <h1>H5P Player</h1>
        <iframe src="{H5P_SERVER}/play/{h5p_id}?userId={user}"></iframe>
    </body>
    </html>
    '''

@app.get("/edit/{h5p_id}")
async def edit(h5p_id: str):
    """Redirect to H5P editor for existing content."""
    return_url = f'{APP_URL}/callback'
    return RedirectResponse(f'{H5P_SERVER}/edit/{h5p_id}?returnUrl={return_url}')

@app.get("/grades/{content_db_id}", response_class=HTMLResponse)
async def grades(content_db_id: int):
    """Show grades for a piece of content."""
    async with aiosqlite.connect(DATABASE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute('SELECT * FROM h5p_content WHERE id = ?', (content_db_id,)) as cursor:
            content = await cursor.fetchone()
        async with db.execute('''
            SELECT * FROM h5p_grades WHERE content_id = ? ORDER BY created_at DESC
        ''', (content_db_id,)) as cursor:
            grades_list = await cursor.fetchall()

    title = content['title'] if content else 'Unknown'
    grades_html = ""

    if grades_list:
        grades_html = '''
        <table>
            <tr><th>User</th><th>Score</th><th>Verb</th><th>Date</th></tr>
        '''
        for grade in grades_list:
            score_pct = (grade['score'] / grade['max_score'] * 100) if grade['max_score'] else 0
            grades_html += f'''
            <tr>
                <td>{grade['user_id']}</td>
                <td>{grade['score']:.1f}/{grade['max_score']:.1f} ({score_pct:.0f}%)</td>
                <td>{grade['xapi_verb'] or '-'}</td>
                <td>{grade['created_at']}</td>
            </tr>
            '''
        grades_html += '</table>'
    else:
        grades_html = '<p class="empty">No grades recorded yet.</p>'

    return f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>Grades - {title}</title>
        <style>
            body {{ font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }}
            .back {{ margin-bottom: 20px; display: inline-block; }}
            table {{ width: 100%; border-collapse: collapse; }}
            th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
            th {{ background: #f5f5f5; }}
            .empty {{ color: #666; font-style: italic; }}
        </style>
    </head>
    <body>
        <a href="/" class="back">&larr; Back to Library</a>
        <h1>Grades: {title}</h1>
        {grades_html}
    </body>
    </html>
    '''

@app.post("/webhook")
async def webhook(payload: WebhookPayload):
    """
    Webhook endpoint to receive xAPI scores from H5P server.

    Expected payload:
    {
        "contentId": "123",
        "userId": "user-1",
        "statement": {
            "verb": { "id": "http://adlnet.gov/expapi/verbs/completed" },
            "result": { "score": { "raw": 8, "max": 10 }, "completion": true }
        }
    }
    """
    raw_score = 0
    max_score = 100
    completed = False
    verb = ""

    if payload.statement:
        if payload.statement.result:
            if payload.statement.result.score:
                raw_score = payload.statement.result.score.raw
                max_score = payload.statement.result.score.max
            completed = payload.statement.result.completion
        if payload.statement.verb:
            verb = payload.statement.verb.id.split('/')[-1]

    async with aiosqlite.connect(DATABASE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute('SELECT id FROM h5p_content WHERE h5p_id = ?', (payload.contentId,)) as cursor:
            content = await cursor.fetchone()

        if not content:
            return JSONResponse({'error': 'Content not found'}, status_code=404)

        await db.execute('''
            INSERT INTO h5p_grades (content_id, user_id, score, max_score, completed, xapi_verb)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (content['id'], payload.userId, raw_score, max_score, completed, verb))
        await db.commit()

    return {
        'status': 'saved',
        'contentId': payload.contentId,
        'score': raw_score / max_score if max_score else 0
    }

# ============================================================================
# Main
# ============================================================================

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
