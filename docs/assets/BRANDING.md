# Archify brand assets

Use `archify-mark.svg` for the symbol and `archify-lockup-light.svg` /
`archify-lockup-dark.svg` for the full logo on light / dark backgrounds.
These are the same vector assets used by the README and website. Do not
reconstruct the logo from an older screenshot or ask an image model to redraw it.

The README hero and social preview are generated from the light lockup and
`archify-architecture.png`, an existing product output. The retired cyan cube
mark must not be reintroduced through either preview.

To rebuild both PNGs, make `sharp` available to Node (maintainer tooling only),
then run `node scripts/build-brand-previews.cjs` from the repository root.
The social preview remains 1200 × 630 and the README hero remains 1440 × 810.
Inspect both outputs after rebuilding. This does not rebuild the Skill ZIP.
