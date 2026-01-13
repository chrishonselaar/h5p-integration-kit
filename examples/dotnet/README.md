# H5P Integration - .NET 8 Example

A minimal single-file ASP.NET Core application demonstrating H5P content creation, playback, and score tracking using .NET 8 Minimal APIs.

## Features

- **Minimal API**: Modern .NET 8 pattern - no controllers needed
- **Records**: Clean data models using C# records
- **SQLite**: File-based database via Microsoft.Data.Sqlite
- **Complete H5P Integration**: Create, edit, play, and track scores

## Quick Start

### Prerequisites

- .NET 8 SDK
- H5P server running at `http://localhost:3000`

### Installation

```bash
# From this directory
dotnet restore
dotnet run
```

### Usage

1. Open http://localhost:5000
2. Click "Create New Content" to open the H5P editor
3. Create your interactive content and save
4. Click "Play" to interact with the content
5. Check "Grades" to see recorded scores

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Home page with content list |
| `/create` | GET | Opens H5P editor for new content |
| `/callback` | GET | Receives contentId from H5P editor |
| `/play/{id}` | GET | Plays H5P content in iframe |
| `/edit/{id}` | GET | Opens H5P editor for existing content |
| `/grades/{id}` | GET | Shows grades for content |
| `/webhook` | POST | Receives xAPI scores from H5P server |

## Data Models (C# Records)

```csharp
record WebhookPayload(
    string? ContentId,
    string UserId = "anonymous",
    XApiStatement? Statement = null
);

record XApiStatement(
    XApiVerb? Verb = null,
    XApiResult? Result = null
);

record XApiResult(
    XApiScore? Score = null,
    bool Completion = false,
    bool Success = false
);

record XApiScore(
    double Raw = 0,
    double Max = 100
);
```

## Configuration

Edit the constants at the top of `Program.cs`:

```csharp
const string H5P_SERVER = "http://localhost:3000";  // H5P server URL
const string APP_URL = "http://localhost:5000";     // This app's URL
const string DATABASE = "h5p_data.db";              // SQLite database file
```

## Files

- `Program.cs` - Complete .NET application (~300 lines)
- `H5PExample.csproj` - Project file with dependencies
- `h5p_data.db` - SQLite database (created automatically)

## Code Structure

```csharp
// Configuration
const string H5P_SERVER = "...";

// Routes (Minimal API pattern)
app.MapGet("/", () => { ... });
app.MapGet("/play/{h5pId}", (string h5pId) => { ... });
app.MapPost("/webhook", async (HttpRequest request) => { ... });

// Database
void InitializeDatabase() { ... }

// Data models (records)
record WebhookPayload(...);
```

## Production Deployment

### Build for Production

```bash
dotnet publish -c Release -o ./publish
cd publish
./H5PExample
```

### Docker

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 5000

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app

FROM base AS final
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "H5PExample.dll"]
```

## Why .NET?

- Enterprise-grade framework
- Strong typing with C# records
- Excellent performance
- Rich ecosystem (Azure, etc.)
- Native AOT compilation available in .NET 8
