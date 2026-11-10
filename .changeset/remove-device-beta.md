---
'@tulip/appwright': minor
---

Installing appwright no longer pulls in `@empiricalrun/llm`, and with it that package's AI SDKs, AWS SDK, `handlebars` and its own copy of `sharp` (Appium's optional `sharp` stays).

**Migration.** `device.beta.query()` and `device.beta.tap()` are removed, along with the
`ExtractType` type. There is no replacement: a test that used them taps a locator or reads its
text instead. `zod` is no longer installed with appwright; a project that imported it without
declaring it must add it to its own dependencies.
