# Security Policy

## Supported Versions

The following versions of `@hasna/hooks` are currently supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

We take the security of `@hasna/hooks` seriously. If you discover a security vulnerability, we appreciate your help in disclosing it to us in a responsible manner.

### For Non-Sensitive Reports

If the vulnerability is **not sensitive** (e.g., a minor issue that does not expose user data or enable exploitation), please open a [GitHub issue](https://github.com/hasna/hooks/issues) with the label `security`.

Include the following information:

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact of the vulnerability
- Any suggested fixes (if applicable)

### For Sensitive Reports

If the vulnerability is **sensitive** (e.g., it could be actively exploited, exposes secrets, or affects user safety), please **do not** open a public GitHub issue. Instead, report it privately via email:

**Email:** [security@hasna.dev](mailto:security@hasna.dev)

Include the following in your email:

- A detailed description of the vulnerability
- Steps to reproduce the issue
- The potential impact and severity
- Your name and contact information (optional, but helpful for follow-up)

### What to Expect

- **Acknowledgement:** We will acknowledge receipt of your report within 48 hours.
- **Assessment:** We will investigate and assess the vulnerability within 7 days.
- **Resolution:** We aim to release a fix for confirmed vulnerabilities within 30 days, depending on severity and complexity.
- **Credit:** We will credit reporters in the release notes unless anonymity is requested.

### Scope

This security policy applies to the `@hasna/hooks` package and all hook packages distributed within this repository. It covers:

- The CLI tool (`hooks`)
- The core library (`@hasna/hooks`)
- All hook packages under the `hooks/` directory
- The MCP server integration

### Best Practices for Users

- Always use the latest supported version of `@hasna/hooks`.
- Review hook configurations before installing them into your project.
- Do not commit secrets or API keys in hook configuration files.
- Report any suspicious behavior observed during hook execution.

## Thank You

Thank you for helping keep `@hasna/hooks` and its users safe.
