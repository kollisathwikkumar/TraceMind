# Changelog

## [0.9.0](https://github.com/kollisathwikkumar/TraceMind/compare/v0.8.0...v0.9.0) (2026-10-18)


### Features

* expose FalkorDB impact and lifecycle workflows ([64b9fad](https://github.com/kollisathwikkumar/TraceMind/commit/64b9fadc22a2e1a2abffc0f1a6c637bc4536c92c))
* harden multi-tenant backend release ([f54ccfa](https://github.com/kollisathwikkumar/TraceMind/commit/f54ccfa85cf593f73874705faed4c3b52ddc2ebf))
* report safe upstream LLM failure diagnostics ([6466ef5](https://github.com/kollisathwikkumar/TraceMind/commit/6466ef56a7ffcd49595050c0aaa76484294f6c14))
* retry model validation with fallback key ([9901a25](https://github.com/kollisathwikkumar/TraceMind/commit/9901a254690c689da6838e9396ec5368b57aaba8))
* validate primary and fallback LLM keys independently ([d6e707d](https://github.com/kollisathwikkumar/TraceMind/commit/d6e707d1a15755ef37fce1a367338bb2765edb49))


### Bug Fixes

* allow Nemotron reasoning budget during validation ([a0031c6](https://github.com/kollisathwikkumar/TraceMind/commit/a0031c6f3b0c71dcc764d4bbe97b1d4f08979a60))
* allow new organization members to load dashboard ([4ac0cca](https://github.com/kollisathwikkumar/TraceMind/commit/4ac0cca14942395f80051dce9ef030598a690384))
* disable reasoning for LLM connectivity probe ([1fed5ef](https://github.com/kollisathwikkumar/TraceMind/commit/1fed5efd20268c71d353833a490fbea7c22a33f5))
* grant graph catalog runtime access after creation ([3b6b8c0](https://github.com/kollisathwikkumar/TraceMind/commit/3b6b8c074c77ee766ba3364146f4eab2283e0c11))
* guard Nemotron probes against empty reasoning streams ([d3dff4f](https://github.com/kollisathwikkumar/TraceMind/commit/d3dff4fb46f51950eeace032ecc6d781e8e529cd))
* identify reasoning-only NVIDIA validation streams ([9f2757c](https://github.com/kollisathwikkumar/TraceMind/commit/9f2757c1fb12a0b56889201b17515858e8c2813b))
* include validation grant in Auth0 token request ([026f37f](https://github.com/kollisathwikkumar/TraceMind/commit/026f37fd6f43f2714bd98802e9f9d84b61ecf0ce))
* load LLM provider from deployment environment ([c921066](https://github.com/kollisathwikkumar/TraceMind/commit/c921066c13d5f41e73ba060663106334a58ff24a))
* preserve Auth0 organization invitations ([a3207df](https://github.com/kollisathwikkumar/TraceMind/commit/a3207df1de6625a2bf1874979bf8919e7f502932))
* request Auth0 organization claims in dashboard ([1de556e](https://github.com/kollisathwikkumar/TraceMind/commit/1de556ebcb7657c9da3359b8790ba95ca7bfe919))
* request LLM validation permission ([fecd62a](https://github.com/kollisathwikkumar/TraceMind/commit/fecd62adf57e9ad6e3e505bbe2c3bfc58b98b9d6))
* request only model validation scope ([0779888](https://github.com/kollisathwikkumar/TraceMind/commit/07798883081f0ff8af9bc25c6cafb37b0ca38407))
* reserve Nemotron output budget for validation answers ([287dcc8](https://github.com/kollisathwikkumar/TraceMind/commit/287dcc814c7fec90caf1cdb88e503b70ee8695a7))
* retry LLM validation on empty primary response ([1fc82f5](https://github.com/kollisathwikkumar/TraceMind/commit/1fc82f5efa41c39e7d073b4bbe7bdd3e4951879c))
* scope NVIDIA validation options to NIM ([67ce050](https://github.com/kollisathwikkumar/TraceMind/commit/67ce0502341ca6b346e78d0e45f1966684dbf47b))
* send NVIDIA NIM token budget field ([2d0680b](https://github.com/kollisathwikkumar/TraceMind/commit/2d0680b1d6e013a105fdce6eb9316241f9dc4b7f))
* use direct-answer mode for NVIDIA validation probes ([49af684](https://github.com/kollisathwikkumar/TraceMind/commit/49af6843aec0399c5d026ed7f1951fe2715983c6))
* validate compatible LLMs with JSON completions ([2a688f9](https://github.com/kollisathwikkumar/TraceMind/commit/2a688f9bc99412f8511ea8b2e5a8addb09fee6ae))

## [0.8.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.7.0...v0.8.0) (2026-03-02)


### Features

* **server:** add embedded admin web UI ([#105](https://github.com/Runbook-Agent/RunbookAI/issues/105)) ([0e22020](https://github.com/Runbook-Agent/RunbookAI/commit/0e22020d358abaf9f9be1bc994669f5760384dc3))
* **site:** add polished animations to landing page ([#106](https://github.com/Runbook-Agent/RunbookAI/issues/106)) ([7e198a0](https://github.com/Runbook-Agent/RunbookAI/commit/7e198a0592726ed2705a098c2379be4aaf7d6d1a))
* **site:** strengthen homepage positioning and conversion CTAs ([#102](https://github.com/Runbook-Agent/RunbookAI/issues/102)) ([76c77ac](https://github.com/Runbook-Agent/RunbookAI/commit/76c77ac9b801eb53b0f796afc2220c221edf002d))

## [0.7.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.6.0...v0.7.0) (2026-03-02)


### Features

* **docs:** revamp landing page with new copy and light theme ([#97](https://github.com/Runbook-Agent/RunbookAI/issues/97)) ([93950bc](https://github.com/Runbook-Agent/RunbookAI/commit/93950bc6efd7768397068d34c8de0a6f5de5bf6d))
* **server:** add shared knowledge server and remote retriever ([#100](https://github.com/Runbook-Agent/RunbookAI/issues/100)) ([a0493b4](https://github.com/Runbook-Agent/RunbookAI/commit/a0493b4308fbd12b36e6573f42c67c7d9fb5ed0b))

## [0.6.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.5.0...v0.6.0) (2026-02-19)


### Features

* **agent:** add compact summarizers for k8s code and ops incidents ([#90](https://github.com/Runbook-Agent/RunbookAI/issues/90)) ([3c40c32](https://github.com/Runbook-Agent/RunbookAI/commit/3c40c32e7f30d65964d3d2b7bbd6aadd786fea5c))
* **cli:** add json output for status investigate and mcp tools ([#91](https://github.com/Runbook-Agent/RunbookAI/issues/91)) ([62e8135](https://github.com/Runbook-Agent/RunbookAI/commit/62e81353f7b74a1781c0a73ea8db24b5057b7244))
* **integrations:** persist hook tool usage and stop checkpoints ([#88](https://github.com/Runbook-Agent/RunbookAI/issues/88)) ([f8f08be](https://github.com/Runbook-Agent/RunbookAI/commit/f8f08beb9c02b1cf8d373782371b6b6978332fd0))


### Performance Improvements

* **integrations:** cache hook knowledge retriever between events ([#92](https://github.com/Runbook-Agent/RunbookAI/issues/92)) ([30a054d](https://github.com/Runbook-Agent/RunbookAI/commit/30a054d3ccf6d62a4204b36077e4833270ba87da))

## [0.5.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.4.1...v0.5.0) (2026-02-18)


### Features

* add asciinema demo recording to website and README ([#68](https://github.com/Runbook-Agent/RunbookAI/issues/68)) ([bab183b](https://github.com/Runbook-Agent/RunbookAI/commit/bab183bec6c67c73a34dc26dc273e958a52529c0))
* add generic API knowledge source ingestion ([#80](https://github.com/Runbook-Agent/RunbookAI/issues/80)) ([0169820](https://github.com/Runbook-Agent/RunbookAI/commit/0169820938e6c54be601718d7dcce8a55b3caa67))
* add github and gitlab code-fix pointers for investigations ([#69](https://github.com/Runbook-Agent/RunbookAI/issues/69)) ([9b905e3](https://github.com/Runbook-Agent/RunbookAI/commit/9b905e30d18387e0257cd7a8ed66c341e87463be))
* add notion knowledge source ingestion ([#79](https://github.com/Runbook-Agent/RunbookAI/issues/79)) ([2a7dc0a](https://github.com/Runbook-Agent/RunbookAI/commit/2a7dc0a08e8d1165a2253f84aec1bd18ba46a77d))
* add operability context adapter implementations ([#66](https://github.com/Runbook-Agent/RunbookAI/issues/66)) ([0fdf700](https://github.com/Runbook-Agent/RunbookAI/commit/0fdf70041c8110d1722589ecee999b5fa4429118))
* add operability context ingestion flow ([#64](https://github.com/Runbook-Agent/RunbookAI/issues/64)) ([d343a95](https://github.com/Runbook-Agent/RunbookAI/commit/d343a952286bc36a153ebdd65fb2c5f22c1870ac))
* configured knowledge sources + hybrid retrieval ([#77](https://github.com/Runbook-Agent/RunbookAI/issues/77)) ([d5d9ee3](https://github.com/Runbook-Agent/RunbookAI/commit/d5d9ee3a950a7e6b27bc4ed0b8a3a76ce00d7782))
* validate knowledge source credentials and fields ([#81](https://github.com/Runbook-Agent/RunbookAI/issues/81)) ([ead8850](https://github.com/Runbook-Agent/RunbookAI/commit/ead8850d3dee7ef25d74a3ee5655261e0069f6d0))


### Bug Fixes

* convert demo.cast timestamps from relative to absolute ([#72](https://github.com/Runbook-Agent/RunbookAI/issues/72)) ([b454070](https://github.com/Runbook-Agent/RunbookAI/commit/b454070ac3a1889cf247f4e192e7d3cc467c4a49))
* convert demo.cast to v2 format and add GIF to README ([#71](https://github.com/Runbook-Agent/RunbookAI/issues/71)) ([6cdae65](https://github.com/Runbook-Agent/RunbookAI/commit/6cdae6520346c9ff8ae14f032a1b70c67a256414))
* restore runbook_context adapter type in config enum ([#70](https://github.com/Runbook-Agent/RunbookAI/issues/70)) ([b209f63](https://github.com/Runbook-Agent/RunbookAI/commit/b209f63c351af53985deab356d22309346a4536d))

## [0.4.1](https://github.com/Runbook-Agent/RunbookAI/compare/v0.4.0...v0.4.1) (2026-02-12)


### Bug Fixes

* use tsup for ESM-compatible builds ([#61](https://github.com/Runbook-Agent/RunbookAI/issues/61)) ([40bd47f](https://github.com/Runbook-Agent/RunbookAI/commit/40bd47f4efe108a88b2c18c958e915c3e2078881))

## [0.4.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.3.0...v0.4.0) (2026-02-12)


### Features

* update homepage with demo command and simplified hero ([#56](https://github.com/Runbook-Agent/RunbookAI/issues/56)) ([b751f6c](https://github.com/Runbook-Agent/RunbookAI/commit/b751f6c2b29219274e1032e636d31a3a61e558dd))


### Bug Fixes

* add files field to include dist in npm publish ([#59](https://github.com/Runbook-Agent/RunbookAI/issues/59)) ([a497ed8](https://github.com/Runbook-Agent/RunbookAI/commit/a497ed858fc8c88d3e509752b80422648a0796e2))
* remove duplicate demo command from hero ([#58](https://github.com/Runbook-Agent/RunbookAI/issues/58)) ([c1d1e77](https://github.com/Runbook-Agent/RunbookAI/commit/c1d1e77ad50eb72d0abcc14bcbbd0c903cc81029))

## [0.3.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.2.3...v0.3.0) (2026-02-12)


### Features

* add demo command for zero-config experience ([#54](https://github.com/Runbook-Agent/RunbookAI/issues/54)) ([8527e4a](https://github.com/Runbook-Agent/RunbookAI/commit/8527e4ac7fa837102358eae2f246d332800753fb))

## [0.2.3](https://github.com/Runbook-Agent/RunbookAI/compare/v0.2.2...v0.2.3) (2026-02-12)


### Bug Fixes

* add npm provenance metadata and normalize bin path ([#49](https://github.com/Runbook-Agent/RunbookAI/issues/49)) ([4a1b5bc](https://github.com/Runbook-Agent/RunbookAI/commit/4a1b5bcf285b5988713a782ee1ead91c36027dff))

## [0.2.2](https://github.com/Runbook-Agent/RunbookAI/compare/v0.2.1...v0.2.2) (2026-02-12)


### Bug Fixes

* enforce tokenless npm trusted publishing in release workflow ([#45](https://github.com/Runbook-Agent/RunbookAI/issues/45)) ([fdcd375](https://github.com/Runbook-Agent/RunbookAI/commit/fdcd375b87c81320305a4034c7db3646cac361f6))

## [0.2.1](https://github.com/Runbook-Agent/RunbookAI/compare/v0.2.0...v0.2.1) (2026-02-12)


### Bug Fixes

* publish to npm inside release-please workflow ([#43](https://github.com/Runbook-Agent/RunbookAI/issues/43)) ([24d844d](https://github.com/Runbook-Agent/RunbookAI/commit/24d844d309f96749c04eba3471fad440d62e58b4))

## [0.2.0](https://github.com/Runbook-Agent/RunbookAI/compare/v0.1.0...v0.2.0) (2026-02-12)


### Features

* add one-command release automation ([#38](https://github.com/Runbook-Agent/RunbookAI/issues/38)) ([cbc2d45](https://github.com/Runbook-Agent/RunbookAI/commit/cbc2d45c86235159e3bd993ea5adb5e2af7faef0))
* Claude Code integration with context injection, MCP server, and checkpoints ([#26](https://github.com/Runbook-Agent/RunbookAI/issues/26)) ([ec8d2fa](https://github.com/Runbook-Agent/RunbookAI/commit/ec8d2faa86a16729ecdcc7d9b3ff18d47728fe83))


### Bug Fixes

* support release-please token fallback for org policy ([#40](https://github.com/Runbook-Agent/RunbookAI/issues/40)) ([72a43df](https://github.com/Runbook-Agent/RunbookAI/commit/72a43dfbb81d4a7ade094670e025196aea8734cb))
