# External Assets & Licensing Attribution

## Saturn V
- **Asset**: `models/saturn-v-nasa.glb`
- **Credit**: NASA / Michael D. Carbajal.
- **Source**: https://science.nasa.gov/3d-resources/saturn-v/
- **Usage guidance**: https://www.nasa.gov/nasa-brand-center/images-and-media/
- The NASA mesh is normalized to 111 m and sliced into stage assemblies in the game. Newly exposed upper-stage engine bells are procedural additions. NASA does not endorse this game.

## 1. Falcon 9 & Payload 3D Models
- **Assets**: `falcon9-stage1.glb`, `falcon9-stage2.glb`, `falcon9-upper.glb`, `starlink-v1.glb`
- **Source**: Space Radar (`https://models.spaceradar.ai/falcon9-stage1/` & `https://github.com/Sara-Managed-Projects/space-radar`)
- **Attribution**: Falcon 9 first stage, second stage / upper stage, and Starlink v1 satellite 3D models by Space Radar (spaceradar.ai), MIT License.
- **License**: MIT License (permissive; allows commercial and non-commercial use, modification, and redistribution with attribution).

## 2. Cape Canaveral Real-World Satellite Imagery & Elevation Data
- **Assets**: `cape_sat_local.png` (4.4 km SLC-40 ortho), `cape_sat_mid.png` (36 km Cape Canaveral & Merritt Island ortho), `cape_sat_wide.png` (180 km Central Florida regional ortho), `cape_dem_mid.png` (3DEP elevation raster)
- **Source**: U.S. Geological Survey (USGS) — The National Map (`USGSImageryOnly` MapServer & `3DEPElevation` ImageServer, `https://www.usgs.gov/programs/national-geospatial-program/national-map`)
- **License**: **Public Domain** (U.S. Federal Government work; no copyright restrictions; credit USGS National Geospatial Program).

## 3. Global Earth Imagery & 8K Cloud Textures
- **Assets**: `earth_daymap.jpg` (8K), `earth_nightmap.jpg` (2K), `earth_clouds.jpg` (8K)
- **Source**: Solar System Scope (`https://www.solarsystemscope.com/textures/`), based on NASA elevation and Blue Marble imagery data.
- **License**: Creative Commons Attribution 4.0 International (CC BY 4.0) — https://creativecommons.org/licenses/by/4.0/
- **Attribution**: Earth day, night, and 8K cloud textures by Solar System Scope (solarsystemscope.com), based on NASA Blue Marble data, licensed under CC BY 4.0.

## 4. Audio Engine
- **Implementation**: 100% procedural Web Audio API synthesis (`src/audio/audioEngine.ts`) — zero external copyrighted audio samples required.
