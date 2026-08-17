# lirrly.com

Hand-built static site for Lirrly. No build step, no dependencies — `index.html` + `styles.css` + `main.js`.

## Preview locally

```bash
cd site
python3 -m http.server 8899
# → http://localhost:8899
```

(Or just open `index.html` — everything is relative.)

## Deploy — GitHub Pages (recommended)

1. Repo must be public (or GitHub Pro for private Pages).
2. GitHub → repo **Settings → Pages** → Source: **GitHub Actions**.
3. Push — `.github/workflows/site.yml` deploys `site/` on any change under it.
4. **Custom domain**: Settings → Pages → Custom domain → `lirrly.com` (the `CNAME` file here keeps it sticky). Wait for the DNS check, then tick **Enforce HTTPS**.

### Namecheap DNS (from the domain panel → Advanced DNS)

| Type  | Host | Value                   |
|-------|------|-------------------------|
| A     | @    | 185.199.108.153         |
| A     | @    | 185.199.109.153         |
| A     | @    | 185.199.110.153         |
| A     | @    | 185.199.111.153         |
| CNAME | www  | m55h11r11.github.io.    |

Remove the existing URL Redirect record for `@` (lirrly.com → www.lirrly.com) first — A records and the redirect conflict.

## Deploy — fallback

Drag the `site/` folder into Cloudflare Pages (or Netlify Drop) and point the domain there instead.

## Fonts

Self-hosted variable woff2, subset:

- **EB Garamond** + **Figtree** — SIL Open Font License 1.1, copied from the app's Fontsource packages (see `lirrly/NOTICE` for full attribution + license text).
- **Readex Pro** (Arabic) — SIL OFL 1.1, © The Readex Project Authors.
