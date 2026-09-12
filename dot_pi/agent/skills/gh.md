---
name: gh
description: Use GitHub during coding and research.
---

# gh

`gh` drives GitHub from terminal. Auth via stored token or `GH_TOKEN`. Scripts must stay non-interactive: pass `--fill/--title/--body`, set `GH_PROMPT_DISABLED=1`.

## Targeting

```bash
gh repo view OWNER/REPO
gh issue list -R OWNER/REPO
gh pr view 123 -R HOST/OWNER/REPO
GH_REPO=OWNER/REPO gh issue list
GH_TOKEN=ghp_xxx gh api user
```

- `-R/--repo [HOST/]OWNER/REPO` overrides local git context.
- `{owner} {repo} {branch}` in `gh api` expand from cwd or `GH_REPO`.
- Env: `GH_TOKEN`, `GH_REPO`, `GH_HOST`, `GH_PROMPT_DISABLED=1`, `GH_PAGER=cat`, `GH_DEBUG=api`.

## Output

```bash
gh pr list --json number,title,author --jq '.[].title'
gh issue list --json number,title --template '{{range .}}{{.number}} {{.title}}{{"\n"}}{{end}}'
gh api repos/{owner}/{repo}/issues --jq '.[].title'
gh api graphql --paginate -F owner='{owner}' -F name='{repo}' -f query='query($endCursor:String){viewer{repositories(first:100 after:$endCursor){nodes{nameWithOwner}pageInfo{hasNextPage endCursor}}}}'
```

- `--json` needs field list, omit value to discover fields.
- `--jq` needs no jq binary. `--template` uses Go templates.
- `--paginate --slurp` walks all pages.
- `-F` magic-converts `true/false/null/ints/@file`, `-f` sends raw strings, `--input file.json` sends body.

## Code loop

```bash
gh repo clone cli/cli
gh repo view --json name,defaultBranchRef,pushAccess
gh repo sync --branch main
gh repo read-file main.go --repo OWNER/REPO
gh repo read-dir script --repo OWNER/REPO
gh pr list --search "review:required" --state open --limit 30
gh pr view 353 --comments
gh pr diff 353
gh pr checks 353 --watch
gh pr checkout 353
gh pr create --fill --base main --head feat-x
gh pr review 353 --approve --body OK
gh pr merge 353 --squash --delete-branch
gh issue list --search "label:bug" --state open --limit 30
gh issue view 123 --comments
gh issue create --title T --body B --label bug
gh issue close 123 --reason completed
gh release view v1.0
gh release download v1.0 --pattern '*.tar.gz'
gh browse 123 --no-browser
```

- `pr` accepts number, URL, or head branch. `co` aliases `pr checkout`.
- Prefer `read-file/read-dir/view/diff` before clone when researching.
- `release download` fetches binaries without git history.

## Research

```bash
gh search repos "language:typescript stars:>1000" --limit 20 --json fullName,url
gh search code "useState" --language tsx --limit 20
gh search issues "repo:cli/cli label:bug" --state open
gh search prs "author:monalisa" --merged
gh search commits "fix auth" --repo OWNER/REPO
gh api repos/{owner}/{repo} --method GET
gh api repos/{owner}/{repo}/contents/path --jq '.content'
gh status --exclude owner/repo --org myorg
```

- Exclusion needs `--`: `gh search issues -- "query -label:bug"`.
- Fall back to `gh api` when a subcommand lacks fields.
- `gh status` surfaces assigned PRs, review requests, mentions.

## CI

```bash
gh run list --workflow ci.yml --branch main --limit 20
gh run view 123 --log-failed
gh run watch 123 --exit-status
gh run rerun 123 --failed
gh run download 123 -n artifacts
gh workflow list
gh workflow run ci.yml --ref main -f version=1.0
gh secret list --env prod
gh variable list --env prod
```
