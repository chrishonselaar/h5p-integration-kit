<?php
/**
 * H5P Integration Example - PHP (Single File)
 * =============================================
 * A minimal PHP script demonstrating H5P content creation, playback, and scoring.
 * No framework required - just PHP with PDO/SQLite.
 *
 * Requirements:
 *     PHP 7.4+ with PDO SQLite extension (usually built-in)
 *
 * Run:
 *     php -S localhost:5000
 *
 * Then open http://localhost:5000 in your browser.
 * Make sure the H5P server is running at http://localhost:3000
 */

// ============================================================================
// Configuration
// ============================================================================

define('H5P_SERVER', 'http://localhost:3000');
define('APP_URL', 'http://localhost:5000');
define('DATABASE', __DIR__ . '/h5p_data.db');

// ============================================================================
// Database Setup
// ============================================================================

function getDb(): PDO {
    static $db = null;
    if ($db === null) {
        $db = new PDO('sqlite:' . DATABASE);
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        initDb($db);
    }
    return $db;
}

function initDb(PDO $db): void {
    $db->exec('
        CREATE TABLE IF NOT EXISTS h5p_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            h5p_id TEXT UNIQUE NOT NULL,
            title TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ');
    $db->exec('
        CREATE TABLE IF NOT EXISTS h5p_grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id INTEGER REFERENCES h5p_content(id),
            user_id TEXT NOT NULL,
            score REAL,
            max_score REAL,
            completed INTEGER DEFAULT 0,
            xapi_verb TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ');
}

// ============================================================================
// Routing
// ============================================================================

$action = $_GET['action'] ?? 'home';
$id = $_GET['id'] ?? null;

switch ($action) {
    case 'home':
        showHome();
        break;
    case 'create':
        redirectToEditor();
        break;
    case 'callback':
        handleCallback();
        break;
    case 'play':
        showPlayer($id);
        break;
    case 'edit':
        redirectToEditor($id);
        break;
    case 'grades':
        showGrades($id);
        break;
    case 'webhook':
        handleWebhook();
        break;
    default:
        http_response_code(404);
        echo 'Not found';
}

// ============================================================================
// Route Handlers
// ============================================================================

function showHome(): void {
    $db = getDb();
    $stmt = $db->query('SELECT * FROM h5p_content ORDER BY created_at DESC');
    $contentList = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $itemsHtml = '';
    if ($contentList) {
        foreach ($contentList as $item) {
            $title = htmlspecialchars($item['title'] ?: 'Untitled');
            $h5pId = htmlspecialchars($item['h5p_id']);
            $dbId = (int)$item['id'];
            $itemsHtml .= <<<HTML
            <li class="content-item">
                <span class="content-title">{$title}</span>
                <span class="actions">
                    <a href="?action=play&id={$h5pId}">Play</a>
                    <a href="#" class="edit" onclick="openEditor('{$h5pId}'); return false;">Edit</a>
                    <a href="?action=grades&id={$dbId}" class="grades">Grades</a>
                </span>
            </li>
HTML;
        }
    } else {
        $itemsHtml = '<li class="empty">No content yet. Create your first H5P activity!</li>';
    }

    $h5pServer = H5P_SERVER;
    $appUrl = APP_URL;

    echo <<<HTML
<!DOCTYPE html>
<html>
<head>
    <title>H5P Integration - PHP Example</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .content-list { list-style: none; padding: 0; }
        .content-item { padding: 15px; margin: 10px 0; background: #f5f5f5; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
        .content-title { font-weight: bold; }
        .actions a { margin-left: 10px; padding: 8px 16px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; }
        .actions a.edit { background: #6c757d; }
        .actions a.grades { background: #28a745; }
        .btn-create { display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; margin-bottom: 20px; }
        .empty { color: #666; font-style: italic; }
    </style>
</head>
<body>
    <h1>H5P Content Library</h1>
    <a href="#" class="btn-create" onclick="openEditor(); return false;">+ Create New Content</a>
    <ul class="content-list">{$itemsHtml}</ul>
    <script>
        function openEditor(contentId) {
            const returnUrl = encodeURIComponent('{$appUrl}?action=callback');
            const url = contentId
                ? '{$h5pServer}/edit/' + contentId + '?returnUrl=' + returnUrl
                : '{$h5pServer}/new?returnUrl=' + returnUrl;
            window.open(url, 'h5p-editor', 'width=1200,height=800');
        }
        window.addEventListener('focus', () => setTimeout(() => location.reload(), 500));
    </script>
</body>
</html>
HTML;
}

function redirectToEditor(?string $contentId = null): void {
    $returnUrl = urlencode(APP_URL . '?action=callback');
    $url = $contentId
        ? H5P_SERVER . '/edit/' . $contentId . '?returnUrl=' . $returnUrl
        : H5P_SERVER . '/new?returnUrl=' . $returnUrl;
    header('Location: ' . $url);
    exit;
}

function handleCallback(): void {
    $contentId = $_GET['contentId'] ?? null;
    $title = $_GET['title'] ?? 'Untitled';

    if ($contentId) {
        $db = getDb();
        $stmt = $db->prepare('
            INSERT INTO h5p_content (h5p_id, title) VALUES (?, ?)
            ON CONFLICT(h5p_id) DO UPDATE SET title = excluded.title
        ');
        $stmt->execute([$contentId, $title]);
    }

    echo <<<HTML
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
HTML;
}

function showPlayer(string $h5pId): void {
    $userId = $_GET['user'] ?? 'demo-user';
    $h5pServer = H5P_SERVER;
    $h5pId = htmlspecialchars($h5pId);
    $userId = htmlspecialchars($userId);

    echo <<<HTML
<!DOCTYPE html>
<html>
<head>
    <title>Play H5P Content</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
        h1 { color: #333; margin-bottom: 10px; }
        .back { margin-bottom: 20px; display: inline-block; }
        iframe { width: 100%; height: 600px; border: 1px solid #ddd; border-radius: 8px; }
    </style>
</head>
<body>
    <a href="?" class="back">&larr; Back to Library</a>
    <h1>H5P Player</h1>
    <iframe src="{$h5pServer}/play/{$h5pId}?userId={$userId}"></iframe>
</body>
</html>
HTML;
}

function showGrades(int $contentDbId): void {
    $db = getDb();

    $stmt = $db->prepare('SELECT * FROM h5p_content WHERE id = ?');
    $stmt->execute([$contentDbId]);
    $content = $stmt->fetch(PDO::FETCH_ASSOC);

    $stmt = $db->prepare('SELECT * FROM h5p_grades WHERE content_id = ? ORDER BY created_at DESC');
    $stmt->execute([$contentDbId]);
    $grades = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $title = htmlspecialchars($content['title'] ?? 'Unknown');

    $gradesHtml = '';
    if ($grades) {
        $gradesHtml = '<table><tr><th>User</th><th>Score</th><th>Verb</th><th>Date</th></tr>';
        foreach ($grades as $grade) {
            $scorePct = $grade['max_score'] > 0
                ? round($grade['score'] / $grade['max_score'] * 100)
                : 0;
            $user = htmlspecialchars($grade['user_id']);
            $verb = htmlspecialchars($grade['xapi_verb'] ?: '-');
            $date = htmlspecialchars($grade['created_at']);
            $gradesHtml .= <<<HTML
            <tr>
                <td>{$user}</td>
                <td>{$grade['score']}/{$grade['max_score']} ({$scorePct}%)</td>
                <td>{$verb}</td>
                <td>{$date}</td>
            </tr>
HTML;
        }
        $gradesHtml .= '</table>';
    } else {
        $gradesHtml = '<p class="empty">No grades recorded yet.</p>';
    }

    echo <<<HTML
<!DOCTYPE html>
<html>
<head>
    <title>Grades - {$title}</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        .back { margin-bottom: 20px; display: inline-block; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; }
        .empty { color: #666; font-style: italic; }
    </style>
</head>
<body>
    <a href="?" class="back">&larr; Back to Library</a>
    <h1>Grades: {$title}</h1>
    {$gradesHtml}
</body>
</html>
HTML;
}

function handleWebhook(): void {
    header('Content-Type: application/json');

    // Only accept POST
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
        return;
    }

    // Parse JSON body
    $input = file_get_contents('php://input');
    $data = json_decode($input, true);

    if (!$data || !isset($data['contentId'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid payload']);
        return;
    }

    $contentId = $data['contentId'];
    $userId = $data['userId'] ?? 'anonymous';
    $statement = $data['statement'] ?? [];

    // Extract score from xAPI statement
    $result = $statement['result'] ?? [];
    $scoreData = $result['score'] ?? [];
    $rawScore = $scoreData['raw'] ?? 0;
    $maxScore = $scoreData['max'] ?? 100;
    $completed = $result['completion'] ?? false;
    $verb = basename($statement['verb']['id'] ?? '');

    $db = getDb();

    // Find content record
    $stmt = $db->prepare('SELECT id FROM h5p_content WHERE h5p_id = ?');
    $stmt->execute([$contentId]);
    $content = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$content) {
        http_response_code(404);
        echo json_encode(['error' => 'Content not found']);
        return;
    }

    // Store grade
    $stmt = $db->prepare('
        INSERT INTO h5p_grades (content_id, user_id, score, max_score, completed, xapi_verb)
        VALUES (?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([
        $content['id'],
        $userId,
        $rawScore,
        $maxScore,
        $completed ? 1 : 0,
        $verb
    ]);

    echo json_encode([
        'status' => 'saved',
        'contentId' => $contentId,
        'score' => $maxScore > 0 ? $rawScore / $maxScore : 0
    ]);
}
