---
'@tulip/appwright': minor
---

`local-device` iOS projects accept `xcodeOrgId` and `xcodeSigningId` for signing WebDriverAgent on a physical device (`appium:xcodeOrgId` / `appium:xcodeSigningId`). Unset values are not sent, so they can be read from a `.env` in the config (`xcodeOrgId: process.env.XCODE_ORG_ID`) and the same config still works without them.

`local-device` and `emulator` projects also accept `capabilities`, a map of extra Appium capabilities merged over the ones appwright builds; bare names get the `appium:` prefix unless they are W3C capabilities.
