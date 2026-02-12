# Viscoelastic Model Builder

An interactive web tool for building arbitrary viscoelastic rheological models by combining **springs** (elastic elements) and **dashpots** (viscous elements) in series and parallel arrangements. It computes and plots both the **creep response** (strain under constant stress) and **relaxation response** (stress under constant strain).

> Created by [Egemen Okte](https://egemenokte.com)

---

## How It Works

Each element is treated as a mechanical impedance in the Laplace domain:

- **Spring:** Z(s) = E
- **Dashpot:** Z(s) = ηs
- **Series elements** combine like parallel resistors (compliances add)
- **Parallel elements** combine like series resistors (impedances add)

The time-domain response is recovered via numerical inverse Laplace transform using the **Stehfest algorithm**.

### Load Removal and Recovery

When enabled, the tool uses the **Boltzmann superposition principle** to simulate what happens after the load is removed at a given time t₁. It superimposes a negative step at t₁ onto the original response, so the total response for t > t₁ becomes R(t) − R(t − t₁). This reveals whether the material recovers fully, partially, or not at all.

## Supported Models

The tool includes presets for classic models and generalizes to handle any tree-structured spring–dashpot network:

| Model | Elements | Description |
|-------|----------|-------------|
| Maxwell | Spring + Dashpot in series | Stress relaxation, viscous flow |
| Kelvin–Voigt | Spring + Dashpot in parallel | Creep with full recovery |
| Standard Linear Solid (Zener) | 3 elements | Combines relaxation and recovery |
| Burgers | 4 elements | Instantaneous + delayed elasticity + viscous flow |
| Generalized Maxwell (Prony) | N arms in parallel | Broad relaxation spectrum |

## How to Use

1. **Pick a preset** from the *Presets* tab or **build your own** model in the *Build* tab.
2. **Click any element** in the schematic or tree to select it. Edit its properties, add children to groups, remove elements, or convert groups between series and parallel.
3. **Adjust parameters** (loading magnitudes, time range, load removal settings) in the *Params* tab. Values are applied when you press Enter or click away from the input field.
4. The **creep and relaxation curves update automatically** as you modify the model.

## Local Development

```bash
npm install
npm run dev
```

Opens at [http://localhost:5173](http://localhost:5173).

## Deploy to Google Cloud Run

### Prerequisites
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A GCP project with billing enabled

### Steps

```bash
# Set your project ID
export PROJECT_ID=your-gcp-project-id

# Build and push the container image
gcloud builds submit --tag gcr.io/$PROJECT_ID/rheology

# Deploy to Cloud Run
gcloud run deploy rheology \
  --image gcr.io/$PROJECT_ID/rheology \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

The app will be served at the URL printed by `gcloud run deploy`.

## Technology

- **React** — UI framework
- **Recharts** — chart library for creep/relaxation plots
- **Vite** — build tooling
- **Nginx** — production static file server (in Docker)
