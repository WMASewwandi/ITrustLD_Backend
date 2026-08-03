import { getMaintenanceModeCached } from '../services/maintenanceMode.service.js';

function isMaintenanceBypassPath(path) {
  if (path === '/' || path === '/health' || path === '/health/db') {
    return true;
  }
  if (path === '/public/maintenance-mode' || path.startsWith('/public/maintenance-mode/')) {
    return true;
  }
  if (path.startsWith('/admin/')) {
    return true;
  }
  return false;
}

export async function enforceMaintenanceMode(req, res, next) {
  if (isMaintenanceBypassPath(req.path)) {
    next();
    return;
  }

  try {
    const maintenanceMode = await getMaintenanceModeCached();
    if (!maintenanceMode.enabled) {
      next();
      return;
    }

    res.status(503).json({
      ok: false,
      maintenanceMode: true,
      message: maintenanceMode.message,
    });
  } catch (error) {
    next(error);
  }
}
