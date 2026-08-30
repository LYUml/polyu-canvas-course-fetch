# PolyU Canvas Course Fetch

Download course files visible to your own Canvas account without creating an API token.

The app opens a dedicated Chrome profile, lets you sign in normally, and reuses that login on later runs. It discovers files through multiple read-only routes:

- Modules and module items
- Assignments and their descriptions/attachments
- Pages
- Announcements and discussions
- Visible links on Canvas course pages

It never bypasses Canvas permissions. Locked, unpublished, external-tool, DRM-protected, or otherwise inaccessible content is skipped.

## Windows quick start

1. Install [Node.js](https://nodejs.org/) and Google Chrome.
2. Download or clone this repository.
3. Double-click `fetch.bat`.
4. On the first run, sign in to Canvas in the Chrome window, then return to the terminal and press Enter.

Files are saved inside the repository's `courses` folder by default. This folder contains only one folder per course and its materials. Copy `config.example.json` to `config.json` to change the Canvas URL or destination.

## macOS quick start

1. Install [Node.js](https://nodejs.org/) and Google Chrome.
2. Download or clone this repository.
3. In Finder, double-click `fetch.command`.
4. If macOS blocks the first launch, right-click `fetch.command`, choose **Open**, and confirm.
5. On the first run, sign in to Canvas in Chrome, then return to Terminal and press Enter.

If the file is not executable after downloading an archive, run `chmod +x fetch.command` once in Terminal.

The `courses` folder is generated locally for each user and is excluded from Git. Course materials must never be committed or distributed through this repository.

## Privacy

The reusable browser profile is stored under the current user's local application-data directory and is never placed in this repository. Do not share that profile. The tool does not ask for passwords or transmit cookies, course content, or analytics to the developer.

## Limitations

Canvas installations can disable individual API routes. This tool automatically tries several routes, but it can only save content the signed-in user can open. External platforms such as Panopto, Turnitin, publisher sites, and LTI tools are outside its scope.
