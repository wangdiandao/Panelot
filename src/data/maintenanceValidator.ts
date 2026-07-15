import {
  portableSkills,
  validateCanonicalImportPlan,
  validateMaterializedSettings,
} from './importValidator';
import { maintenanceDigest, type MaintenanceValidator } from './maintenanceRuntime';

export const inProcessMaintenanceValidator: MaintenanceValidator = {
  async buildPlan(input, _operationId) {
    const bundle = await validateCanonicalImportPlan(input);
    return {
      bundle,
      portableSkills: portableSkills(bundle.skills),
      digest: await maintenanceDigest(input),
    };
  },
  async validateMaterialized(settings, localSecretKey, existingKey, plannedSettings) {
    await validateMaterializedSettings(settings, localSecretKey, existingKey, plannedSettings);
  },
};
