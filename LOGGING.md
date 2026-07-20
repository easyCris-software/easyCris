# Production Logging Guide

## Overview

The app uses a unified logging stack across all layers:

- **Frontend**: `@tauri-apps/api/log` (MIT/Apache-2.0)
- **Rust Backend**: `tokio-rs/tracing` + `tracing-log` bridge + `tauri-plugin-log` (MIT)
- **Python**: Standard `print()` statements → captured by Rust

## Architecture

```
Frontend (TypeScript)          Rust Backend                    Python
    │                               │                             │
    ├──> @tauri-apps/api/log ──────>│                             │
                                     │                             │
    Rust Code                        │                             │
    ├──> tracing::info!() ───> tracing-log bridge                 │
                                     │                             │
                               tauri-plugin-log ◄─── print() ──────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
                Terminal      Browser DevTools   System Logs
```

## Log Destinations

Logs automatically flow to:

1. **Terminal** (`stdout`) - Development server output
2. **Browser DevTools** (F12 → Console) - Frontend logs
3. **System Logs** (macOS Console.app) - Production logging
4. **Log Files** (optional) - Persistent storage

## Frontend Usage

### Quick Logging (Global)

```typescript
import { log } from '@/utils/logger'

log.info('User action completed', { userId: 123 })
log.error('Operation failed', error, { context: 'data-import' })
log.debug('Processing data', { rows: 1000 })
```

### Module Logger (Recommended)

```typescript
import { createLogger } from '@/utils/logger'

const logger = createLogger('MyComponent')

logger.info('Component mounted')
logger.warn('Deprecated feature used', { feature: 'oldAPI' })
logger.error('Validation failed', error, { field: 'email' })

// Child logger with extended context
const childLogger = logger.child('SubModule')
childLogger.debug('Sub-process started')
```

### React Component Example

```typescript
import { createLogger } from '@/utils/logger'

const logger = createLogger('StatisticsPanel')

export function StatisticsPanel() {
  useEffect(() => {
    logger.info('Panel initialized')
    return () => logger.debug('Panel unmounted')
  }, [])

  const handleAnalysis = async () => {
    try {
      logger.info('Starting analysis', { testType: 'two_way_anova' })
      const result = await runTest()
      logger.info('Analysis complete', { resultSize: result.data.length })
    } catch (error) {
      logger.error('Analysis failed', error)
    }
  }

  return <div>...</div>
}
```

## Rust Backend Usage

### Using `tracing` Macros

```rust
use tracing::{info, debug, warn, error, trace};

pub fn process_data(data: &[f64]) -> Result<f64> {
    info!("Processing {} data points", data.len());

    debug!("Data range: [{}, {}]", data.iter().min()?, data.iter().max()?);

    if data.is_empty() {
        warn!("Empty dataset received");
        return Err("No data to process");
    }

    let result = calculate(data);
    info!(result = %result, "Processing complete");

    Ok(result)
}
```

### Structured Logging with Fields

```rust
use tracing::instrument;

#[instrument(skip(payload), fields(test_name = %test_name, data_size = payload.data.len()))]
pub async fn run_statistical_test(test_name: String, payload: TestPayload) -> Result<TestResult> {
    info!("Test execution started");

    let result = execute_test(&payload).await?;

    debug!(
        factor_count = result.factors.len(),
        p_value = %result.p_value,
        "Test completed"
    );

    Ok(result)
}
```

## Python Subprocess Logs

Python `print()` statements are automatically captured:

```python
# In python_embedded/statistics_module/anova.py
def anova_two_way(data, factor1, factor2, **kwargs):
    print(f"[ANOVA] Processing {len(data)} observations")
    print(f"[ANOVA] Factors: {factor1_name} × {factor2_name}")

    result = compute_anova(data, factor1, factor2)

    print(f"[ANOVA] F-statistic: {result['f_value']:.3f}")
    return result
```

These appear in the terminal output alongside Rust logs.

## Log Levels

| Level | When to Use | Example |
|-------|-------------|---------|
| `trace` | Very verbose, fine-grained execution details | Loop iterations, every function call |
| `debug` | Development diagnostics, helpful for debugging | Variable values, intermediate results |
| `info` | Production informational messages | User actions, operation completion |
| `warn` | Recoverable issues, deprecation notices | Fallback used, suboptimal config |
| `error` | Failures requiring attention | Operation failed, validation error |

## Environment Filters

Control log verbosity with environment variables:

```bash
# Development (verbose)
RUST_LOG=debug npm run tauri dev

# Production (quiet)
RUST_LOG=info npm run tauri dev

# Module-specific
RUST_LOG=debug,hyper=info,reqwest=info npm run tauri dev

# Specific module only
RUST_LOG=tauri_app_lib::modules::statistics=trace npm run tauri dev
```

## Best Practices

### ✅ DO

- **Use structured metadata**: `logger.info('Test complete', { testId, rows })`
- **Log user actions**: Start/completion of important operations
- **Log errors with context**: Include error object + relevant metadata
- **Use child loggers**: Create context-specific loggers for subsystems
- **Log API boundaries**: Requests/responses to external services

### ❌ DON'T

- **Don't log PII**: No user emails, passwords, sensitive data
- **Don't log in loops**: Aggregate and log summary instead
- **Don't use `console.log`**: Use the logger utility for unified output
- **Don't log secrets**: API keys, tokens, credentials
- **Don't over-log**: Every variable assignment doesn't need a log

## Debugging ANOVA Results

Example logging strategy for troubleshooting:

```typescript
const logger = createLogger('ANOVAController')

async function executeANOVA(data: Data) {
  logger.info('ANOVA execution started', {
    testType: 'two_way',
    factors: 2,
    observations: data.length
  })

  const payload = buildPayload(data)
  logger.debug('Payload constructed', {
    hasDependent: !!payload.dependent,
    factor1Length: payload.factor1.length,
    factor2Length: payload.factor2.length
  })

  const result = await invokePython('two_way_anova', payload)
  logger.debug('Python result received', {
    testType: result.test_type,
    hasFactorF: 'factor1_f' in result,
    topLevelKeys: Object.keys(result).slice(0, 10)
  })

  if (!result.factor1_f) {
    logger.warn('Missing factor1_f in result', {
      availableKeys: Object.keys(result)
    })
  }

  logger.info('ANOVA complete', {
    factor1F: result.factor1_f,
    factor2F: result.factor2_f,
    interactionP: result.interaction_p
  })

  return result
}
```

## Viewing Logs

### Development

**Terminal output:**
```
2025-12-11T00:30:15.123Z INFO  [StatisticalAnalysisController] Executing Two-Way ANOVA {"columns":3,"rows":45}
2025-12-11T00:30:15.456Z DEBUG [StatisticalAnalysisController] ANOVA result structure {"testType":"two_way","hasMainEffects":false,"hasFactor1F":true}
```

**Browser DevTools (F12):**
- Open Console tab
- Filter by source file or module name
- Structured metadata appears as expandable objects

### Production (macOS)

1. Open **Console.app**
2. Filter for process: `easyCris` or `tauri-app`
3. View realtime logs with full structured data

## Quick Start: ANOVA Debugging

**Run the app:**
```bash
npm run tauri dev
```

**When you run Two-Way ANOVA**, check the terminal for:

```
INFO [StatisticalAnalysisController] Executing Two-Way ANOVA {"columns":3,"rows":45}
DEBUG [StatisticalAnalysisController] ANOVA result structure {"testType":"two_way","hasFactor1F":true,...}
```

This shows:
- ✅ What test_type Python returned
- ✅ Which F-statistic keys exist (factor1_f, factor2_f, interaction_f)
- ✅ What top-level keys are in the result

**Also check Browser DevTools (F12 → Console)** for the same logs.

## GitHub Stars Reference

- **tokio-rs/tracing** (~7k+ ⭐) - Rust structured logging (MIT)
- **tokio-rs/tracing-log** - Bridge between tracing and log crate (MIT)
- **tauri-apps/tauri-plugin-log** (~1k+ ⭐) - Unified log output (MIT/Apache-2.0)
- **@tauri-apps/api** (part of Tauri ecosystem) - Frontend bridge (MIT/Apache-2.0)

All tools are MIT-licensed and production-ready.
