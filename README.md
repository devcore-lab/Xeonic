# Xeonic

Local AI data cleaner for AI-ready text and chunks. The backend is now Node.js.

## Run

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:8000
```

Do not open `app.html` directly as `file://`; cleaning needs the Node backend.

## Replit

Import these files into a Node.js Repl:

- `app.html`
- `server.js`
- `package.json`
- `package-lock.json`
- `.replit`

Then press **Run**. The included `.replit` file starts the app with:

```bash
npm start
```

The server binds to `0.0.0.0` and uses Replit's `$PORT` automatically. Accounts, passwords, access codes, plan choices, payments, and usage are saved in SQLite at `xeonic.db` so they survive Repl restarts.

`main.py` and `requirements.txt` are no longer needed for the Node version.

## Supported Inputs

- `.txt`
- `.json`
- `.epub`
- `.md` / `.markdown`
- `.html` / `.htm`
- `.csv`
- `.tsv`

## Exports

- JSON with cleaned text, lines, stats, and AI chunks
- TXT cleaned text
- JSONL AI chunks
- CSV AI chunks

## Access Code Login

Xeonic uses email, account passwords, and a hidden access-code field. Sign up with any valid email, any password, and any access code. Existing accounts log in with the same password and the same access code they were created with.

Optional CORS setting. By default Replit/browser previews are allowed with `*`:

```text
ALLOWED_ORIGINS=*
```

## Notes

This is a local prototype, not a fully production-grade service. It now stores account data in SQLite, while active browser sessions still reset when the server restarts.
