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
    echo "=========================================================="
    echo "To run: python backend/server.py"
  '';
}
