---
'@tulip/appwright': minor
---

Run tests on several local devices or emulators at once. One Appium server is started per run (on a free port, torn down at the end) instead of one per worker, the new `device.devices` list assigns one device or emulator to each Playwright worker (`workers` may be raised up to the number of entries; a single `udid` still works as shorthand), Appium driver installation is skipped when the driver is already installed, and the device fixture no longer restarts Appium after every test.
