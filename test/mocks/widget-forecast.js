var sample = require('../fixtures/widget-weather.json');
module.exports = function () {
  return { ok: true, available: true, stale: true, temperature: 12.5, code: 2,
    current: { temperature: 12.5, code: 2, wind: 14, isDay: true },
    units: { temperature: '°C', wind: 'km/h' },
    today: { date: '2026-11-07', labels: ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'],
      temperature: sample.hourly.temperature_2m.slice(), wind: sample.hourly.wind_speed_10m.slice() },
    daily: sample.daily.time.map(function (date, i) { return { date: date,
      code: sample.daily.weather_code[i], high: sample.daily.temperature_2m_max[i], low: sample.daily.temperature_2m_min[i],
      wind: sample.daily.wind_speed_10m_max[i], rain: sample.daily.precipitation_probability_max[i] }; }) };
};
