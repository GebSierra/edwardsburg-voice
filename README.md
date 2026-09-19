# The Edwardsburg Voice — website

This is the website that hosts The Edwardsburg Voice online. It's a set of plain files —
no software to install, no account to log into except GitHub.

## Adding next month's issue

1. Upload the new PDF into the `issues/` folder. Name it `YYYY-MM.pdf` — for example,
   `2026-10.pdf` for October 2026.
2. Open `issues.json` and add one line at the **top** of the `issues` list (newest issue
   always goes first):

   ```json
   { "id": "2026-10", "label": "October 2026", "file": "issues/2026-10.pdf" },
   ```

   So the file looks like this:

   ```json
   {
     "title": "The Edwardsburg Voice",
     "issues": [
       { "id": "2026-10", "label": "October 2026", "file": "issues/2026-10.pdf" },
       { "id": "2026-09", "label": "September 2026", "file": "issues/2026-09.pdf" }
     ]
   }
   ```

3. Save both changes. Within a minute or two, the website updates itself automatically —
   nothing else to do.

That's it. The new issue becomes the one that opens by default; last month's issue moves
into "Past issues" automatically.

## A few rules of thumb

- **File naming always follows `YYYY-MM.pdf`.** If two issues come out in the same month,
  add a letter: `2026-10b.pdf`.
- **Keep each PDF under about 10MB** so it opens quickly on a phone. If a PDF is larger,
  re-export it from whatever program made it using a "web" or "smaller file size" setting —
  most software that makes PDFs has one.
- **Don't rename or delete anything already in `issues.json`** unless you mean to remove
  that issue from the site.

## Changing the background photos

The photos behind the title rotate every 8 seconds. They live in `assets/img/`:

| File | Where it shows |
|---|---|
| `welcome-sign.webp` | Behind the title, first |
| `water-tower.webp` | Behind the title, second |
| `lunkers.webp` | Behind the title, third |
| `grain-elevator-mural.webp` | The faint band above "Past issues" |

To swap one out, replace the file with a new photo of the same name. Use a **wide**
photo (roughly twice as wide as it is tall) so it fits the space without awkward cropping.

To change which photos are used, open `assets/styles.css` and look for the three rules
named `.hero__photo--a`, `--b`, and `--c`. Each one names its photo file.

## What not to touch

Everything else in this folder — `index.html`, the `assets/` folder, the `vendor/` folder —
is the website itself. There's no reason to open or edit those to publish a new issue.

## A note on privacy

The newspaper pages are shown as images on the page, and there's no "Download" button — but
because this is a plain website, anyone who really wants the original PDF file can still find
it by looking at what the page loads behind the scenes. This is a limit of free, simple
website hosting, not a bug. If that ever becomes a real concern, ask about adding real access
control — it would mean the site can no longer be hosted for free.

## Hosting

This site runs on GitHub Pages (free) with a small yearly domain fee. It has no server, no
database, and nothing that can "go down" apart from GitHub itself.
