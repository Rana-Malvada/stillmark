// Offline policy generation; no service mutation happens here.
export function uploadScalingPolicy(settings, evidence) {
  const config = settings.scaling
  if (!config?.enabled) {
    if (settings.minInstances !== settings.maxInstances)
      throw Error(
        'Disabled scaling requires equal instance bounds; Snowflake otherwise enables CPU autoscaling',
      )
    return undefined
  }
  if (!settings.queuedProcessing || !settings.metricsEnabled)
    throw Error('Autoscaling requires queued processing and live queue metrics')
  if (
    !evidence ||
    evidence.image !== settings.image ||
    ![
      'recovery',
      'scaleOut',
      'routing',
      'metrics',
      'browserRecovery',
      'automaticScaling',
      'nodeReclamation',
    ].every((k) => evidence[k] === 'passed') ||
    !evidence.report ||
    !Number.isInteger(evidence.testedInstances) ||
    settings.maxInstances > evidence.testedInstances
  )
    throw Error(
      'Autoscaling requires matching recovery, scale-out, routing, metrics, browser, automatic-scaling and node-reclamation evidence covering the configured cap',
    )
  for (const key of ['queueThreshold', 'waitSeconds', 'scaleUpSeconds', 'scaleDownSeconds']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw Error(`Invalid scaling.${key}`)
  }
  if (config.scaleUpSeconds < 60 || config.scaleDownSeconds < 600)
    throw Error('Scaling stabilization windows are too short')
  const condition = (name, seconds, step) => ({
    metricCondition: {
      metricName: name,
      aggregationType: 'max',
      stabilizationPeriodSecs: seconds,
      stepScaling: {
        adjustmentType: 'changeInstanceCount',
        scalingSteps: [{ ...step, targetAdjustment: 1 }],
      },
    },
  })
  return {
    scaleUp: {
      // This account's live SPCS validator requires singular anyCondition for
      // scaleUp, but plural allConditions for scaleDown (October 2026).
      anyCondition: [
        condition('stillmark.upload.ready', config.scaleUpSeconds, {
          lowerBound: config.queueThreshold,
          upperBound: Number.MAX_SAFE_INTEGER,
        }),
        condition('stillmark.upload.oldest_wait_seconds', config.scaleUpSeconds, {
          lowerBound: config.waitSeconds,
          upperBound: Number.MAX_SAFE_INTEGER,
        }),
      ],
    },
    // Include delayed retries and active receiving/processing. Never infer idle from CPU.
    scaleDown: {
      allConditions: [
        condition('stillmark.upload.outstanding', config.scaleDownSeconds, {
          lowerBound: 0,
          upperBound: 0.5,
        }),
        condition('stillmark.upload.local_active', config.scaleDownSeconds, {
          lowerBound: 0,
          upperBound: 0.5,
        }),
      ],
    },
  }
}
