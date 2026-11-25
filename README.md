# REENTRY

A browser spacecraft flight simulator with a real-scale Earth, Cape Canaveral launch site,
WebGPU rendering with a WebGL 2 fallback, and manual flight controls.

## Play

https://bowling220.github.io/reentry/

Use a current desktop browser with hardware acceleration enabled. Press **Space** to launch.
The in-game **KEYS** button shows flight and camera controls.

Choose **Falcon 9 / REENTRY-9** or **Saturn V / Apollo** in the **ROCKET** menu
before launch. Reset to change vehicles. Saturn V has three powered stages:
press **B** to separate S-IC and S-II, then **Space** to ignite the next stage.
Spent stages remain selectable in the tracker. Apollo remains attached to S-IVB.
The Saturn V physics are educational approximations, including game throttle and
attitude controls; both rockets use the shared Cape Canaveral environment.

Press **F** to open the programmable flight computer workspace. The seven
engineering test scenarios use REENTRY-9; standard prelaunch uses your selected rocket.

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

Florida terrain uses three nested, georeferenced USGS imagery layers on the curved
Earth, with procedural PBR detail and real shadows near the launchpad. Regional
detail remains visible through ascent and orbit; the rest of Earth uses the 8K
global map. Imagery is bundled locally, with no map-service requests during play.

See [external asset attribution](public/assets/ATTRIBUTION.md) for spacecraft models and Earth imagery.
