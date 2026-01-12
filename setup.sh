#!/bin/bash
set -e

echo "=== H5P Demo Setup ==="
echo ""

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not installed."
    exit 1
fi

# Check for Node.js (for H5P server)
if ! command -v node &> /dev/null; then
    echo "Warning: Node.js is not installed. You'll need it to run the H5P server locally."
    echo "  Install Node.js 18+ from https://nodejs.org"
    echo "  Or use Docker: docker compose up -d"
    echo ""
fi

# Create virtual environment
if [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
fi

echo "Activating virtual environment..."
source .venv/bin/activate

echo "Installing Python dependencies..."
pip install -q --upgrade pip
pip install -q -r requirements.txt

# Copy .env if it doesn't exist
if [ ! -f ".env" ]; then
    echo "Creating .env file from template..."
    cp .env.example .env
fi

# Run Django migrations
echo "Running database migrations..."
python manage.py migrate

echo "Creating admin superuser (if not exists)..."
python manage.py shell -c "
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(username='admin').exists():
    User.objects.create_superuser('admin', 'admin@example.com', 'admin')
    print('Created admin user (password: admin)')
else:
    print('Admin user already exists')
"

# Setup H5P server
if command -v node &> /dev/null; then
    echo ""
    echo "Setting up H5P server..."
    cd h5p-server
    npm install
    cd ..
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the H5P server:"
echo "  Option 1 (Docker): docker compose up -d"
echo "  Option 2 (Local):  cd h5p-server && npm start"
echo ""
echo "To start Django:"
echo "  source .venv/bin/activate"
echo "  python manage.py runserver"
echo ""
echo "Then open http://localhost:8000 in your browser"
echo ""
echo "Admin panel: http://localhost:8000/admin"
echo "  Username: admin"
echo "  Password: admin"
