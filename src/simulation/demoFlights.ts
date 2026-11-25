import { AUTO_DEMOS } from '../flightComputer/demoPrograms';
import { STAGE1_BOOSTER_SPEC } from '../config/vehicleConfig';
import { RocketFlightDynamics } from './flightDynamics';
import { SpacecraftManager } from './spacecraftManager';

/** Configure the reusable booster demonstrator after a normal scenario reset. */
export function configureDemoVehicle(demo: typeof AUTO_DEMOS[number], manager: SpacecraftManager): void {
  if (!demo.boosterOnly) return;
  const craft = manager.activeSpacecraft;
  craft.id = 'demo-reusable-booster';
  craft.name = 'REENTRY-9 Reusable Booster Demo';
  craft.role = 'booster';
  craft.visuals = { ...STAGE1_BOOSTER_SPEC.visuals };
  craft.dynamics = new RocketFlightDynamics(STAGE1_BOOSTER_SPEC.config, true);
  craft.historyECEF = [{ ...craft.dynamics.posECEF }];
  craft.storedUpperPropellantKg = 0;
  craft.storedPayloadPropellantKg = 0;
  manager.activeId = craft.id;
}
