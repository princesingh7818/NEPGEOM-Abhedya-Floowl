{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = [
    (pkgs.python3.withPackages (ps: with ps; [
      flask
      flask-cors
      numpy
      rasterio
    ]))
    pkgs.sqlite
    pkgs.nodejs
  ];

  shellHook = ''
    echo "=========================================================="
    echo "Welcome to the Mapbox GL + Python + SQLite project shell!"
    echo "Python version: $(python --version)"
    echo "SQLite version: $(sqlite3 --version)"
    echo "=========================================================="

    if [ -d frontend ]; then
      if [ -f frontend/package.json ]; then
        if [ ! -d frontend/node_modules ]; then
          echo "Installing frontend npm dependencies (first run)..."
          npm install --prefix frontend
        else
          echo "Frontend npm dependencies already installed."
        fi
      elif [ -f frontend/package-lock.json ]; then
        echo "Found frontend/package-lock.json but no package.json; skipping npm install."
      else
        echo "No frontend package manifest found; skipping npm install."
      fi
    else
      echo "No frontend directory found; skipping npm install."
    fi
    
    read -p "Would you like to run the website now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Starting the Python server..."
        python backend/server.py
    else
        echo "You are now in the nix shell."
        echo "To run the server later, run 'python backend/server.py'."
    fi
  '';
}
