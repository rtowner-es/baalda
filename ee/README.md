# Enterprise Edition (`ee/`)

> **This directory is _not_ open source.**

Everything in this repository **outside** the `ee/` directory is licensed under
the **[Apache License 2.0](../LICENSE)** — free to use, self-host, modify, and
build on commercially.

Everything **inside** `ee/` is licensed under the separate
**[OpenContext Enterprise License](./LICENSE)** — a commercial, source-available
license. In short: you may read, evaluate, and develop against this code, but
**production use requires a paid subscription** or commercial agreement.

## Purpose

This is where future commercial-only features live (e.g. SSO/SAML, audit logs,
advanced admin/console tooling). Keeping them here draws a clear, permanent line
between the open core and the paid layer.

## Ground rule

Enterprise features **add to** the open core — they must never remove or gate a
capability that already shipped under Apache-2.0. That's what keeps trust with
open-source users.

## Conventions for files added here

- Add a header to each source file, e.g.:
  - TS/JS: `// SPDX-License-Identifier: LicenseRef-OpenContext-Enterprise`
  - Rust:  `// SPDX-License-Identifier: LicenseRef-OpenContext-Enterprise`
- Do not import `ee/` code from the Apache-2.0 core in a way that makes the core
  depend on it — the open build must work without this directory.

## Licensing enquiries

Contact: `naveedharri@gmail.com`
