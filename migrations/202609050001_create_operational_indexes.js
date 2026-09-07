import BlockedIp from '../server/models/BlockedIp.js';
import Migration from '../server/models/Migration.js';
import RequestMetric from '../server/models/RequestMetric.js';
import SystemIncident from '../server/models/SystemIncident.js';
import UserEvent from '../server/models/UserEvent.js';
import UserPreference from '../server/models/UserPreference.js';

export const description = 'Create operational, security, metrics, and recommendation indexes';

export async function up() {
  await Promise.all([
    BlockedIp.createIndexes(),
    Migration.createIndexes(),
    RequestMetric.createIndexes(),
    SystemIncident.createIndexes(),
    UserEvent.createIndexes(),
    UserPreference.createIndexes()
  ]);
}
