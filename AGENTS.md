# Folio development notes

## Browser preview

From the repository root, start or restart the complete authenticated preview with:

```powershell
npm run preview:codex:restart
```

Use this command instead of launching Vite or Uvicorn separately. It starts both services, creates the preview API token, wires the frontend to the backend, starts the watchdog, and prints the URL to open in the in-app browser.

The normal endpoints are:

- Frontend: `http://127.0.0.1:5173/`
- Backend status: `http://127.0.0.1:8000/api/status`

If the standard restart cannot clear a stale listener that belongs to this workspace, use the explicit force variant:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-codex-preview.ps1 -Restart -ForcePorts
```
