# Contributing to Folio

Thanks for taking an interest in Folio.

## Workflow

1. Fork the repository
2. Create a focused branch for your change
3. Keep changes small and easy to review
4. Open a pull request with a clear summary, screenshots if the UI changed, and testing notes

## Development Setup

```powershell
git clone https://github.com/Retrorerr/Folio.git
cd Folio
git lfs pull
python -m pip install -r backend/requirements.txt
cd frontend
npm install
npm run build
```

## Pull Request Expectations

- Explain the user-facing problem being solved
- Call out any tradeoffs or follow-up work
- Include screenshots or short clips for visual changes when possible
- Mention how you tested the change

## Style

- Keep changes readable and focused
- Prefer practical, maintainable solutions over clever ones
- Avoid unrelated refactors in feature or fix PRs

## Issues

Bug reports and feature requests are welcome. Please include enough detail to reproduce the problem or understand the request.
