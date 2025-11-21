/**
 * Tracks remaining checklist tasks for analyzed events so that we only show
 * unscheduled items when a user revisits the event. We intentionally avoid
 * storing the full analysis payload—only the unscheduled tasks plus the set of
 * completed task identifiers are kept in-memory.
 */

const deepCloneTasks = (tasks = []) => {
  try {
    return JSON.parse(JSON.stringify(tasks));
  } catch (error) {
    console.warn('taskCache: Failed to clone tasks', error);
    return Array.isArray(tasks) ? [...tasks] : [];
  }
};

const taskKey = (task) => {
  if (!task) {
    return null;
  }

  if (task.id) {
    return `id:${task.id}`;
  }

  // Match frontend logic: check task.task first, then task.title
  if (task.task) {
    return `task:${task.task.toString().trim().toLowerCase()}`;
  }

  if (task.title) {
    return `title:${task.title.toString().trim().toLowerCase()}`;
  }

  // Fallback: match frontend's fallback logic (category | description | estimatedTime)
  const parts = [
    task.category || '',
    task.description || '',
    task.estimatedTime || ''
  ]
    .map((part) => part.toString().trim().toLowerCase())
    .join('|');

  return `fallback:${parts}`;
};

class TaskCache {
  constructor() {
    /**
     * Map<eventId, { remainingTasks: Array, completedTaskKeys: Set<string>, createdAt: number, updatedAt: number }>
     */
    this.cache = new Map();
  }

  /**
   * Initialize or refresh the remaining tasks list for an event.
   * @param {string} eventId
   * @param {Array<object>} preparationTasks
   */
  setRemainingTasks(eventId, preparationTasks = []) {
    if (!eventId) {
      return;
    }

    const key = String(eventId);
    const entry = this.cache.get(key);
    const clonedTasks = deepCloneTasks(preparationTasks);

    if (entry) {
      entry.remainingTasks = clonedTasks.filter((task) => {
        const identifier = taskKey(task);
        return identifier ? !entry.completedTaskKeys.has(identifier) : true;
      });
      entry.updatedAt = Date.now();
      return;
    }

    this.cache.set(key, {
      remainingTasks: clonedTasks,
      completedTaskKeys: new Set(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  /**
   * Return a cloned array of remaining tasks for the event.
   * @param {string} eventId
   * @returns {Array<object>|null}
   */
  getRemainingTasks(eventId) {
    if (!eventId) {
      return null;
    }

    const key = String(eventId);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    return deepCloneTasks(entry.remainingTasks);
  }

  /**
   * Mark tasks as scheduled so they no longer show in the remaining list.
   * @param {string} eventId
   * @param {Array<object>} tasks
   */
  markTasksCompleted(eventId, tasks = []) {
    if (!eventId || !Array.isArray(tasks) || tasks.length === 0) {
      return;
    }

    const key = String(eventId);
    let entry = this.cache.get(key);

    if (!entry) {
      entry = {
        remainingTasks: [],
        completedTaskKeys: new Set(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.cache.set(key, entry);
    }

    tasks.forEach((task) => {
      const identifier = taskKey(task);
      if (identifier) {
        entry.completedTaskKeys.add(identifier);
      }
    });

    entry.remainingTasks = entry.remainingTasks.filter((task) => {
      const identifier = taskKey(task);
      return identifier ? !entry.completedTaskKeys.has(identifier) : true;
    });

    entry.updatedAt = Date.now();
  }

  /**
   * How many tasks remain unscheduled for the event.
   * @param {string} eventId
   * @returns {number}
   */
  getRemainingCount(eventId) {
    const key = String(eventId);
    const entry = this.cache.get(key);
    return entry ? entry.remainingTasks.length : 0;
  }

  /**
   * Remove cached data for a specific event.
   * @param {string} eventId
   */
  clear(eventId) {
    if (!eventId) {
      return;
    }

    this.cache.delete(String(eventId));
  }

  /**
   * Clear the entire cache (useful for tests).
   */
  clearAll() {
    this.cache.clear();
  }
}

module.exports = new TaskCache();


