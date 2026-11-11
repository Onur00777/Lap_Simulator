# ApexLapSim

Formula Student lap simulation and vehicle dynamics workbench by Onur Yüksek.

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
```

The generated C tests use GCC when available. The strict DBC round-trip test uses Python with `cantools` installed. Set `APEX_DBC_PYTHON` to select a Python executable with that package.

## Workbench

- Compare the active vehicle, a ghost snapshot and a reference vehicle in **Setup Matrix**. The Sensitivity tab ranks the five setup perturbations by lap-time gain.
- **Math Channels** saves expressions in the browser. Telemetry charts compare time at equal physical distance and show splits every 50 m. Drag in a chart to zoom and use the overview to pan or resize the shared window.
- **Powertrain & Tire** replays the solved speed trace with tire core and flash temperatures, rotor fade and voltage-limited regen. Initial temperature settings affect the replay and its braking capacity. Lap timing comes from the QSS solve.
- Space toggles replay. `[` and `]` cycle the playback rate. Left and right arrows seek by 10 m. `G`, `M` and `S` open the G-G diagram, math channels and setup matrix.

### Ride-height aero calibration

Open the engine menu and choose **Load ride-height aero map**. Use measured or simulated coefficients for your vehicle in the following JSON structure. Each row corresponds to a front ride height and each column to a rear ride height. `clA` and `cdA` are in square metres. `frontFraction` is the fraction of downforce at the front axle.

```json
{
  "staticFrontM": 0.033,
  "staticRearM": 0.045,
  "frontWheelRateNPerM": 18000,
  "rearWheelRateNPerM": 18500,
  "map": {
    "frontHeightsM": [0.02, 0.06],
    "rearHeightsM": [0.02, 0.06],
    "clA": [[4.0, 5.0], [3.0, 4.0]],
    "cdA": [[1.0, 1.2], [1.1, 1.3]],
    "frontFraction": [[0.55, 0.60], [0.40, 0.45]]
  }
}
```

The example values describe the file format. Loaded calibration applies to the current session and active vehicle. The combined-slip model uses the project's existing pure-slip coefficients. Thermal constants and the pressure response are reference parameters for simulation.

## İTÜ Havuz Lab

- Upload an IST26 sensor CSV and open **Simülasyon & Araç Kıyaslama** to see the EKF estimate. The upload path treats logged acceleration as gravity-compensated and uses inverter power-on counter changes to infer CAN activity.
- Export the fitted closed track as SVG or GeoJSON. GeoJSON uses an approximate site anchor and axis orientation. The telemetry CSV follows MoTeC export-style headers and reconstructs the time base from distance and speed.
- The VCU stage exports `apex_vcu_bus.dbc`. Cascadia messages use the manufacturer default CAN offset. Apex application frames describe the SIL matrix and need to be matched to the installed ECU and BMS configuration.

The main **VCU Codegen** tab exports `vcu_dynamics.h` and `vcu_dynamics.c` with the torque authorization state machine. The generated task expects validated ECU inputs and a hardware watchdog and shutdown path. The supplied tests cover host compilation and simulated fault transitions. Target integration requires hardware validation and a project-specific MISRA compliance review.

