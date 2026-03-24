# Zotsidian 0.1.1

This is a small follow-up patch release after `0.1.0`.

## What changed

- added support for storing source pages in the vault root by leaving `Source pages folder` empty
- unified source page path handling so lookup, creation, and bootstrap all use the same folder-setting logic
- clarified the setting description for the source pages folder

## Notes

If you prefer not to keep source pages in a dedicated `source/` folder, you can now leave the setting empty and Zotsidian will create new `@citekey` source pages directly in the vault root.
