# REENTRY

A browser spacecraft flight simulator with a real-scale Earth, Cape Canaveral launch site,
WebGPU rendering with a WebGL 2 fallback, and manual flight controls.

## Play

https://bowling220.github.io/reentry/

Use a current desktop browser with hardware acceleration enabled. Press **Space** to launch.
The in-game **KEYS** button shows flight and camera controls.

## Develop

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

## Hosting

Pushes to `main` run the tests, build the game, and deploy `dist` through GitHub Actions.
Set the repository's Pages publishing source to **GitHub Actions**.
Relative asset URLs support hosting under the `/reentry/` repository path.

## Asset credits

See [external asset attribution](public/assets/ATTRIBUTION.md) for spacecraft models and Earth imagery.
