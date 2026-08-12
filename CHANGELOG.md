# Changelog

All notable changes to Peixue will be documented here. The project follows [Semantic Versioning](https://semver.org/) after its first public release.

## [Unreleased]

### Added

- Complete React/Vite/Tailwind frontend source with a reproducible multi-stage Docker build
- Chinese and English project documentation, contribution guidance, security policy, issue forms, CI, and Dependabot configuration
- Synthetic demo import data and a repository privacy/secret/link checker
- Frontend tests for spaced-review scheduling and adversarial SVG sanitization
- Backend tests for authentication caching, password policy, import validation, and family isolation

### Changed

- Secure-by-default same-origin deployment with an Nginx API/SSE proxy and browser security headers
- Frontend dependency lockfile now uses the official npm registry and includes production-dependency notices
- Family administration accepts passwords through a temporary environment variable instead of shell arguments

### Fixed

- Prevent authentication cache collisions from accepting a different password with the same prefix and length
- Keep imported children and learning moments inside the authenticated family boundary
- Wait for cached review-question deletion before generating a replacement question
- Replace the custom SVG filter with a strict DOMPurify allowlist that also sanitizes root attributes and external references
- Repair the PWA icon reference

### Security

- Reject short, example, reused-across-family, and legacy default passwords
- Restrict CORS by default and keep MySQL/backend ports on the internal Compose network
- Add CSP, clickjacking, MIME-sniffing, referrer, and permissions-policy headers
- Prevent tracked `.env`, recovery directories, embedded image data, likely secrets, Windows metadata, and generated frontend bundles
