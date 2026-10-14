---
'@tulip/appwright': minor
---

Concurrent runs on one machine no longer share or shut down each other's devices. Each `appwright test` run leases the devices it uses from the project's pool (`device.devices`, or the single `udid`) before anything boots, releases them at the end, and fails fast with a list of holders when the pool is busy. Per-session Appium ports (`systemPort`, `wdaLocalPort`, `mjpegServerPort`) come from a port slot leased with the device instead of the worker slot, so they no longer collide across runs. New `--device <udid|name>` (or `APPWRIGHT_DEVICE`) pins a run to one device of the pool and exits early when it is not in the pool, not usable, or busy; `--wait-for-device <seconds>` waits for a busy device instead.

Configs without `udid`/`devices` keep auto-picking a device, with a warning that concurrent runs need a pool. The worker-slot lookup `getDeviceEntryForSlot` is replaced by `getLeasedDeviceForSlot`, and `getSlotCapabilities` now takes a port slot and udid.
