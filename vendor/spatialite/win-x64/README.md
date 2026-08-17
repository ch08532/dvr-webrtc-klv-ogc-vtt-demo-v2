# Windows SpatiaLite runtime

The mission catalog requires the Windows x64 SpatiaLite 5.1.0 loadable module.
Place `mod_spatialite.dll` and all of its dependent DLLs in this directory, then
start the service with:

```powershell
$env:SPATIALITE_EXTENSION_PATH = "$PWD\vendor\spatialite\win-x64\mod_spatialite.dll"
npm start
```

The service deliberately fails at startup when the module is missing or cannot
be loaded. Include the upstream license notices for the selected SpatiaLite,
GEOS, PROJ, and SQLite binary distribution alongside the DLLs.
