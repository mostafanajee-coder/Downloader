'use strict';

const EventEmitter = require('events');

/**
 * Task Scheduler Engine matching IDM Schedule & Queue Timers
 */
class ScheduleManager extends EventEmitter {
  constructor(manager) {
    super();
    this.manager = manager;
    this.scheduledTasks = new Map();
    this.timer = null;
    this.initLoop();
  }

  initLoop() {
    this.timer = setInterval(() => {
      this.checkSchedules();
    }, 1000);
  }

  scheduleQueueStart(timeStr, queueName = 'default') {
    this.scheduledTasks.set(`start_${queueName}`, {
      type: 'start_queue',
      timeStr, // e.g. "02:00"
      queueName,
      executedToday: false
    });
    this.emit('schedule-added', { type: 'start_queue', timeStr, queueName });
  }

  scheduleQueueStop(timeStr, queueName = 'default') {
    this.scheduledTasks.set(`stop_${queueName}`, {
      type: 'stop_queue',
      timeStr, // e.g. "06:00"
      queueName,
      executedToday: false
    });
    this.emit('schedule-added', { type: 'stop_queue', timeStr, queueName });
  }

  checkSchedules() {
    const now = new Date();
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const [key, task] of this.scheduledTasks.entries()) {
      if (task.timeStr === currentHHMM) {
        if (!task.executedToday) {
          task.executedToday = true;
          if (task.type === 'start_queue') {
            console.log(`[Scheduler] Triggered Start Queue '${task.queueName}' at ${currentHHMM}`);
            this.manager.startAll();
            this.emit('queue-started', { queueName: task.queueName, time: currentHHMM });
          } else if (task.type === 'stop_queue') {
            console.log(`[Scheduler] Triggered Stop Queue '${task.queueName}' at ${currentHHMM}`);
            this.manager.pauseAll();
            this.emit('queue-stopped', { queueName: task.queueName, time: currentHHMM });
          }
        }
      } else {
        // Reset flag for next day
        task.executedToday = false;
      }
    }
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { ScheduleManager };
