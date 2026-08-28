# Newphorus

Newphorus is a modern browser player for Scratch projects.

## Features

- Scratch 1 (`.sb`), Scratch 2 (`.sb2`), and Scratch 3 (`.sb3`) project support
- Load shared Scratch projects by project ID or URL
- Drag-and-drop and file picker support for local project files
- Green flag, stop, turbo mode, and fullscreen controls
- Responsive modern interface
- Standalone app and iframe embed pages

## Running locally

Serve the repository with any static HTTP server and open `index.html`.

For example:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## Runtime

Newphorus uses [TurboWarp Scaffolding](https://github.com/TurboWarp/scaffolding) as its Scratch execution backend. Scaffolding is loaded from jsDelivr and is licensed under MPL-2.0.

## Links

- Source: https://github.com/itswiktoragain/newphorus
- Issues: https://github.com/itswiktoragain/newphorus/issues
