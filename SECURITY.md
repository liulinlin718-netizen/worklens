# Security policy

## Supported version

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting flow on the repository's **Security** tab.

Include the affected version, reproduction steps, expected impact, and any
suggested mitigation. Please avoid including real credentials or personal work
content in the report. We will acknowledge a complete report as soon as
practical and coordinate disclosure after a fix is available.

## Security boundary

WorkLens stores work records and imported attachments locally. When an AI
provider is enabled, selected text or extracted content can be sent to that
provider. Users should review the provider setting and the content being sent
before enabling AI analysis.
