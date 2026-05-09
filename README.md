# USA Government Awards Stock Indicator

This project fetches government awards (Prime and Subawards) from USAspending.gov, cross-checks recipients against publicly traded companies, and generates reports for investment analysis.

List of stocks here https://ozkanpakdil.github.io/usa-stocks-indicator/

## Features

- **Automated Data Fetching**: Retrieves the latest Prime and Subawards from the last 12 months.
- **Stock Matching**: Automatically maps company names to US stock tickers (NYSE/NASDAQ/etc.).
- **Hugo Integration**: Generates Markdown posts for Hugo-based blogs (e.g., GitHub Pages).
- **GitHub Actions**: Automated weekly runs with auto-commit of new data and reports.
- **Local Cache**: Saves results in `data.json` to prevent redundant API calls.

## Setup

1. Install [Bun](https://bun.sh/).
2. Clone this repository.
3. Run `bun install`.

## Usage

To fetch new data and generate reports:
```bash
bun run start
```

To preview the reports locally with Hugo:
```bash
# Initialize modules if not already done (required for PaperMod theme)
hugo mod tidy
hugo serve
```

This will create/update:
- `data.json`: Local cache of all found awards.
- `content/dashboard.md`: Interactive dashboard (full list).
- `content/posts/awards-YYYY-MM-DD.md`: Hugo-compatible blog post.
- `public/`: (Only when running `hugo`) The generated static site.
- `go.mod`, `go.sum`: Hugo Module tracking files.

## GitHub Actions Automation

The project includes GitHub Actions workflows:
- `.github/workflows/weekly.yml`: Runs every Sunday. It runs the crawler, commits updated data, and deploys the site.
- `.github/workflows/hugo.yml`: Automatically builds and deploys the Hugo site on every push to the `main` branch.

### Deployment to GitHub Pages
To make the site work properly on GitHub Pages:
1. Go to your repository settings on GitHub.
2. Click on **Pages** in the left sidebar.
3. Under **Build and deployment** > **Source**, select **Deploy from a branch**.
4. Select the **gh-pages** branch and **/ (root)** folder.
5. Save the settings. The workflows will now automatically update this branch.

## Manual Automation (Crontab)

Alternatively, use crontab for local runs:
```bash
0 8 * * * cd /path/to/usa-stocks-indicator && /usr/local/bin/bun run index.ts
```
