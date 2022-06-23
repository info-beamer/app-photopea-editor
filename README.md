# Connect info-beamer hosted and Photopea

This is a minimal example of how external tools can be embedded
into info-beamer hosted. This repository implements a way to use
the [Photopea](https://www.photopea.com/) image editor to edit
image assets within your account.

The app uses [OAuth](https://en.wikipedia.org/wiki/OAuth) to request
restricted access (see `requested_scopes` in [index.html](index.html)) to
your info-beamer account. The app itself then uses these permissions
to request the raw image data for an asset and forwards that to the
image editor. Once the editor saves the image its transferred back
to the app which then uploads the changes to info-beamer. The image
editor itself never has direct access to any account data except the
raw image data itself.
