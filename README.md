# PolyU Canvas Course Fetch

Fetch course materials available to your PolyU Canvas account. No API token is required.

## Requirements

- Google Chrome
- [Node.js](https://nodejs.org/)

## Windows

1. Download or clone this repository.
2. Double-click `fetch.bat`.
3. Sign in to Canvas when prompted, then return to the terminal and press Enter.

## macOS

1. Download or clone this repository.
2. Double-click `fetch.command`.
3. If blocked, right-click it and select **Open**.
4. Sign in to Canvas when prompted, then return to Terminal and press Enter.

If needed, run `chmod +x fetch.command` once.

## Structure

```text
polyu-canvas-course-fetch/
├── fetch.bat          # Windows launcher
├── fetch.command      # macOS launcher
├── courses/           # Generated locally; never pushed to Git
│   └── Course name/
│       └── Module name/
│           └── Material files
└── src/               # Fetcher source code
```

## Privacy and disclaimer

- Login data and course materials stay on your device and are not sent to the developer.
- `courses/` is excluded from Git. Do not upload or redistribute course materials without permission.
- The tool only accesses content available to the signed-in user and does not bypass Canvas permissions.
- Locked content and external services such as Panopto, Turnitin, publisher sites, and LTI tools may not be fetched.
- Use this tool at your own risk and follow PolyU policies and applicable copyright rules.
