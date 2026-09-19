# The Edwardsburg Voice — website

This is the website that hosts The Edwardsburg Voice online. It's a set of plain files —
no software to install, no account to log into except GitHub.

## Publishing a new issue

**Upload the PDF. That's the whole job.**

1. Open the [`issues` folder on GitHub](../../tree/main/issues) — bookmark this link.
2. Click **Add file** → **Upload files**.
3. Drag the PDF in and click **Commit changes**.

Wait a minute or two and the site updates itself. The new issue becomes the one that opens
by default, and last month's moves into "Past issues" on its own.

You do **not** need to edit `issues.json`. It rebuilds itself from whatever PDFs are in the
folder.

## Removing an issue

1. Open the [`issues` folder](../../tree/main/issues) and click the PDF you want gone.
2. Click the **⋯** button at the top right of the file view, then **Delete file**.
3. Scroll down and click **Commit changes**.

The issue disappears from the site within a minute or two.

**Don't rename a file to "delete"** — renaming just gives the file a new name, it doesn't
remove it. Use the **Delete file** option above.

### Naming the file

The filename just has to say which month it is. All of these work:

    2026-10.pdf
    October 2026.pdf
    oct-2026.pdf
    2026-10-october-issue.pdf

If the name has no readable month in it (`scan001.pdf`, `final.pdf`), that file is ignored
and the site carries on with the issues it already has.

### One thing to watch

**Keep each PDF under about 10MB** so it opens quickly on a phone. If it's bigger, re-export
it using a "web", "reduced size", or "smaller file size" option — most programs that make
PDFs have one.

### If an issue doesn't show up

Go to the **Actions** tab in the repository and look at the most recent run. It lists every
PDF it found and names any it skipped, along with the reason. That is almost always a
filename with no month in it.

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
