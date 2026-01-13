/*
 * H5P Integration Example - .NET 8 Minimal API (Single File)
 * ===========================================================
 * A minimal ASP.NET Core app demonstrating H5P content creation, playback, and scoring.
 *
 * Requirements:
 *     .NET 8 SDK
 *
 * Run:
 *     dotnet run
 *
 * Then open http://localhost:5000 in your browser.
 * Make sure the H5P server is running at http://localhost:3000
 */

using Microsoft.Data.Sqlite;
using System.Text.Json;
using System.Text.Json.Serialization;

// ============================================================================
// Configuration
// ============================================================================

const string H5P_SERVER = "http://localhost:3000";
const string APP_URL = "http://localhost:5000";
const string DATABASE = "h5p_data.db";

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors();
var app = builder.Build();

app.UseCors(policy => policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());

// Initialize database
InitializeDatabase();

Console.WriteLine($"""

    H5P .NET Example
    ================
    App running at: {APP_URL}
    H5P Server:     {H5P_SERVER}

    Make sure the H5P server is running!

    """);

// ============================================================================
// Routes
// ============================================================================

// Home page - list all H5P content
app.MapGet("/", () =>
{
    var contentList = new List<Dictionary<string, object>>();
    using var conn = new SqliteConnection($"Data Source={DATABASE}");
    conn.Open();
    using var cmd = new SqliteCommand("SELECT * FROM h5p_content ORDER BY created_at DESC", conn);
    using var reader = cmd.ExecuteReader();
    while (reader.Read())
    {
        contentList.Add(new Dictionary<string, object>
        {
            ["id"] = reader.GetInt32(0),
            ["h5p_id"] = reader.GetString(1),
            ["title"] = reader.IsDBNull(2) ? "Untitled" : reader.GetString(2),
            ["created_at"] = reader.GetString(3)
        });
    }

    var itemsHtml = contentList.Count > 0
        ? string.Join("", contentList.Select(item => $"""
            <li class="content-item">
                <span class="content-title">{item["title"]}</span>
                <span class="actions">
                    <a href="/play/{item["h5p_id"]}">Play</a>
                    <a href="/edit/{item["h5p_id"]}" class="edit" onclick="openEditor('{item["h5p_id"]}'); return false;">Edit</a>
                    <a href="/grades/{item["id"]}" class="grades">Grades</a>
                </span>
            </li>
            """))
        : """<li class="empty">No content yet. Create your first H5P activity!</li>""";

    return Results.Content($"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>H5P Integration - .NET Example</title>
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
            <ul class="content-list">{itemsHtml}</ul>
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
        """, "text/html");
});

// Redirect to H5P editor for new content
app.MapGet("/create", () =>
    Results.Redirect($"{H5P_SERVER}/new?returnUrl={Uri.EscapeDataString($"{APP_URL}/callback")}"));

// Callback from H5P editor
app.MapGet("/callback", (string? contentId, string? title) =>
{
    if (!string.IsNullOrEmpty(contentId))
    {
        using var conn = new SqliteConnection($"Data Source={DATABASE}");
        conn.Open();
        using var cmd = new SqliteCommand("""
            INSERT INTO h5p_content (h5p_id, title) VALUES (@id, @title)
            ON CONFLICT(h5p_id) DO UPDATE SET title = excluded.title
            """, conn);
        cmd.Parameters.AddWithValue("@id", contentId);
        cmd.Parameters.AddWithValue("@title", title ?? "Untitled");
        cmd.ExecuteNonQuery();
    }

    return Results.Content("""
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
        """, "text/html");
});

// Play H5P content
app.MapGet("/play/{h5pId}", (string h5pId, string? user) =>
{
    var userId = user ?? "demo-user";
    return Results.Content($"""
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
            <iframe src="{H5P_SERVER}/play/{h5pId}?userId={userId}"></iframe>
        </body>
        </html>
        """, "text/html");
});

// Redirect to H5P editor for existing content
app.MapGet("/edit/{h5pId}", (string h5pId) =>
    Results.Redirect($"{H5P_SERVER}/edit/{h5pId}?returnUrl={Uri.EscapeDataString($"{APP_URL}/callback")}"));

// Show grades
app.MapGet("/grades/{contentDbId:int}", (int contentDbId) =>
{
    string? contentTitle = null;
    var grades = new List<Dictionary<string, object>>();

    using var conn = new SqliteConnection($"Data Source={DATABASE}");
    conn.Open();

    using (var cmd = new SqliteCommand("SELECT title FROM h5p_content WHERE id = @id", conn))
    {
        cmd.Parameters.AddWithValue("@id", contentDbId);
        contentTitle = cmd.ExecuteScalar()?.ToString() ?? "Unknown";
    }

    using (var cmd = new SqliteCommand(
        "SELECT * FROM h5p_grades WHERE content_id = @id ORDER BY created_at DESC", conn))
    {
        cmd.Parameters.AddWithValue("@id", contentDbId);
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            grades.Add(new Dictionary<string, object>
            {
                ["user_id"] = reader.GetString(2),
                ["score"] = reader.GetDouble(3),
                ["max_score"] = reader.GetDouble(4),
                ["xapi_verb"] = reader.IsDBNull(6) ? "-" : reader.GetString(6),
                ["created_at"] = reader.GetString(7)
            });
        }
    }

    var gradesHtml = grades.Count > 0
        ? "<table><tr><th>User</th><th>Score</th><th>Verb</th><th>Date</th></tr>" +
          string.Join("", grades.Select(g =>
          {
              var score = (double)g["score"];
              var maxScore = (double)g["max_score"];
              var pct = maxScore > 0 ? score / maxScore * 100 : 0;
              return $"""
                  <tr>
                      <td>{g["user_id"]}</td>
                      <td>{score:F1}/{maxScore:F1} ({pct:F0}%)</td>
                      <td>{g["xapi_verb"]}</td>
                      <td>{g["created_at"]}</td>
                  </tr>
                  """;
          })) + "</table>"
        : """<p class="empty">No grades recorded yet.</p>""";

    return Results.Content($"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Grades - {contentTitle}</title>
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
            <h1>Grades: {contentTitle}</h1>
            {gradesHtml}
        </body>
        </html>
        """, "text/html");
});

// Webhook to receive xAPI scores
app.MapPost("/webhook", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var body = await reader.ReadToEndAsync();
    var data = JsonSerializer.Deserialize<WebhookPayload>(body);

    if (data == null || string.IsNullOrEmpty(data.ContentId))
        return Results.BadRequest(new { error = "Invalid payload" });

    var rawScore = data.Statement?.Result?.Score?.Raw ?? 0;
    var maxScore = data.Statement?.Result?.Score?.Max ?? 100;
    var completed = data.Statement?.Result?.Completion ?? false;
    var verb = data.Statement?.Verb?.Id?.Split('/').LastOrDefault() ?? "";

    using var conn = new SqliteConnection($"Data Source={DATABASE}");
    conn.Open();

    int? contentDbId = null;
    using (var cmd = new SqliteCommand("SELECT id FROM h5p_content WHERE h5p_id = @id", conn))
    {
        cmd.Parameters.AddWithValue("@id", data.ContentId);
        contentDbId = cmd.ExecuteScalar() as int?;
    }

    if (contentDbId == null)
        return Results.NotFound(new { error = "Content not found" });

    using (var cmd = new SqliteCommand("""
        INSERT INTO h5p_grades (content_id, user_id, score, max_score, completed, xapi_verb)
        VALUES (@contentId, @userId, @score, @maxScore, @completed, @verb)
        """, conn))
    {
        cmd.Parameters.AddWithValue("@contentId", contentDbId);
        cmd.Parameters.AddWithValue("@userId", data.UserId);
        cmd.Parameters.AddWithValue("@score", rawScore);
        cmd.Parameters.AddWithValue("@maxScore", maxScore);
        cmd.Parameters.AddWithValue("@completed", completed ? 1 : 0);
        cmd.Parameters.AddWithValue("@verb", verb);
        cmd.ExecuteNonQuery();
    }

    return Results.Ok(new
    {
        status = "saved",
        contentId = data.ContentId,
        score = maxScore > 0 ? rawScore / maxScore : 0
    });
});

app.Run($"{APP_URL}");

// ============================================================================
// Database Setup
// ============================================================================

void InitializeDatabase()
{
    using var conn = new SqliteConnection($"Data Source={DATABASE}");
    conn.Open();

    using var cmd = new SqliteCommand("""
        CREATE TABLE IF NOT EXISTS h5p_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            h5p_id TEXT UNIQUE NOT NULL,
            title TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS h5p_grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id INTEGER REFERENCES h5p_content(id),
            user_id TEXT NOT NULL,
            score REAL,
            max_score REAL,
            completed INTEGER DEFAULT 0,
            xapi_verb TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """, conn);
    cmd.ExecuteNonQuery();
}

// ============================================================================
// Data Models
// ============================================================================

record WebhookPayload(
    [property: JsonPropertyName("contentId")] string? ContentId,
    [property: JsonPropertyName("userId")] string UserId = "anonymous",
    [property: JsonPropertyName("statement")] XApiStatement? Statement = null
);

record XApiStatement(
    [property: JsonPropertyName("verb")] XApiVerb? Verb = null,
    [property: JsonPropertyName("result")] XApiResult? Result = null
);

record XApiVerb([property: JsonPropertyName("id")] string? Id = null);

record XApiResult(
    [property: JsonPropertyName("score")] XApiScore? Score = null,
    [property: JsonPropertyName("completion")] bool Completion = false,
    [property: JsonPropertyName("success")] bool Success = false
);

record XApiScore(
    [property: JsonPropertyName("raw")] double Raw = 0,
    [property: JsonPropertyName("max")] double Max = 100
);
