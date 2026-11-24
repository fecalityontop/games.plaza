# GTA2 in your browser

Local build of Grand Theft Auto 2 running in the browser via WebAssembly.

## Run

Serve this folder with any static HTTP server and open `index.html`. The game loads automatically from `gamedata/`.

Example:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080/`.

## Notes

- Game data is loaded from local `gamedata/` (no installer/download flow).
- This repo contains built site files; no launcher UI.
- GTA2 is ? Rockstar Games. Unofficial, non-commercial fan project.
