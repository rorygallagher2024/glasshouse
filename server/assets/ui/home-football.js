let homeFootballLeagues = [];
let homeFootballTeams = {};
let homeFootballLeague = '';
let homeFootballBusy = false;
let homeFootballNote = '';
let homeFootballQueries = { league: '', team: '' };

function homeFootballSources(settings) {
  return [{ id: 'fifa.friendly', name: t('home.football.nationalMen', 'National teams (men)') },
    { id: 'fifa.friendly.w', name: t('home.football.nationalWomen', 'National teams (women)') }].concat(
    settings.leagues.filter(item => !['fifa.friendly', 'fifa.friendly.w'].includes(item.id)));
}

function homeFootballChoices(items, selected, kind, off) {
  const query = homeFootballQueries[kind].toLowerCase();
  const found = items.some(item => item.name.toLowerCase().includes(query));
  return `<div class="home-football-choices" id="home-football-${kind}" role="group" aria-label="${esc(kind === 'league' ? t('home.football.leagues', 'Leagues') : t('home.football.teams', 'Teams'))}">
    ${items.map(item => `<label data-name="${esc(item.name.toLowerCase())}" ${item.name.toLowerCase().includes(query) ? '' : 'hidden'}>
      <input type="checkbox" data-football-${kind}="${esc(item.id)}" ${selected.some(entry => entry.id === item.id) ? 'checked' : ''} ${off}
        onchange="homeFootballChoose('${kind}', '${esc(item.id)}', this.checked)"><span>${esc(item.name)}</span></label>`).join('')}
    <p class="prot-desc" role="status" ${found ? 'hidden' : ''}>${esc(t('home.football.noChoices', 'No matching choices. Try another name.'))}</p></div>`;
}

function homeFootballFields(settings, off) {
  const disabled = off || homeFootballBusy ? 'disabled' : '';
  const teams = homeFootballTeams[homeFootballLeague];
  return `<div class="home-widget-fields home-football-fields">
    <p class="prot-desc">${esc(t('home.football.privacy', 'Football scores are off by default. Browsing and enabling scores connects to ESPN, which receives the TV’s public IP address and the requested competitions or teams. No account or API key is needed.'))}
      <a href="https://www.espn.com/soccer/scoreboard" target="_blank" rel="noopener">${esc(t('home.football.credit', 'Scores by ESPN'))}</a></p>
    <p class="prot-desc">${esc(t('home.football.help', 'Choose leagues for all their live matches, or select club or national teams to follow across competitions. When no selected team is playing, their latest results and dates appear. Up to eight leagues and 64 teams can be saved.'))}</p>
    <button type="button" class="pill idle" ${disabled} onclick="homeFootballBrowse()">${esc(t('home.football.browse', 'Browse leagues'))}</button>
    <p class="prot-desc" role="status">${esc(homeFootballBusy ? t('home.football.loadingChoices', 'Loading football choices…') : homeFootballNote)}</p>
    ${homeFootballLeagues.length ? `<label>${esc(t('home.football.findLeague', 'Find a league'))}<input type="search" value="${esc(homeFootballQueries.league)}" oninput="homeFootballFilter(this.value, 'league')" ${off}></label>
      ${homeFootballChoices(homeFootballLeagues, settings.leagues, 'league', disabled)}` : ''}
    <div class="home-football-selected" role="group" aria-label="${esc(t('home.football.selectedLeagues', 'Selected leagues'))}">
      ${settings.leagues.map(item => `<button type="button" class="pill idle" ${disabled} onclick="homeFootballChoose('league', '${esc(item.id)}', false)">${esc(t('home.football.removeLeague', 'Remove {name}', { name: item.name }))}</button>`).join('')}</div>
    <label>${esc(t('home.football.teamsFrom', 'Teams from'))}<select class="pill-sel" aria-label="${esc(t('home.football.teamsFrom', 'Teams from'))}" ${disabled} onchange="homeFootballSelectLeague(this.value)">
      <option value="">${esc(t('home.football.chooseLeague', 'Choose a league'))}</option>${homeFootballSources(settings).map(item => `<option value="${esc(item.id)}" ${homeFootballLeague === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
    ${Array.isArray(teams) ? `<label>${esc(t('home.football.findTeam', 'Find a team'))}<input type="search" value="${esc(homeFootballQueries.team)}" oninput="homeFootballFilter(this.value, 'team')" ${off}></label>
      ${homeFootballChoices(teams, settings.teams, 'team', disabled)}` : ''}
    <div class="home-football-selected" role="group" aria-label="${esc(t('home.football.selectedTeams', 'Selected teams'))}">
      ${settings.teams.map(item => `<button type="button" class="pill idle" ${disabled} onclick="homeFootballChoose('team', '${item.id}', false)">${esc(t('home.football.removeTeam', 'Remove {name}', { name: item.name }))}</button>`).join('')}
      ${settings.teams.length ? `<button type="button" class="pill idle" ${disabled} onclick="homeFootballClearTeams()">${esc(t('home.football.allTeams', 'Clear team selection'))}</button>` : ''}</div>
    <p class="prot-desc">${esc(t('home.football.scrollHelp', 'Long lists scroll upward continuously. Focus the widget to pause; press OK to read all matches.'))}</p>
  </div>`;
}

function homeFootballFilter(query, kind) {
  homeFootballQueries[kind] = query;
  const host = q('home-football-' + kind);
  if (!host) return;
  let found = false;
  host.querySelectorAll('label').forEach(label => {
    label.hidden = !label.dataset.name.includes(query.toLowerCase());
    if (!label.hidden) found = true;
  });
  host.querySelector('[role="status"]').hidden = found;
}

async function homeFootballLoad(kind, league = '') {
  if (!homeWritable() || homeFootballBusy) return;
  homeFootballBusy = true; homeFootballNote = ''; renderHomeWidgets();
  try {
    const result = await homePost('/api/home/widgets/football/' + kind, { league });
    if (kind === 'leagues') homeFootballLeagues = result.leagues;
    else homeFootballTeams[league] = result.teams;
  } catch (e) { homeFootballNote = e.message; }
  homeFootballBusy = false; renderHomeWidgets();
  q('home-widgets')?.querySelector(kind === 'leagues' ? '.home-football-fields input[type="search"]' : '#home-football-team input')?.focus({ preventScroll: true });
}

function homeFootballBrowse() { return homeFootballLoad('leagues'); }
function homeFootballSelectLeague(league) {
  homeFootballLeague = league; homeFootballQueries.team = '';
  if (league && !homeFootballTeams[league]) return homeFootballLoad('teams', league);
  renderHomeWidgets();
}

async function homeFootballChoose(kind, id, on) {
  if (!homeWritable() || homeFootballBusy) return;
  const widgets = homeWidgetSettings(), key = kind === 'league' ? 'leagues' : 'teams';
  const choices = kind === 'league' ? homeFootballLeagues : homeFootballTeams[homeFootballLeague] || [];
  const previous = widgets.football[key], item = choices.find(entry => entry.id === id);
  if (on && (!item || previous.some(entry => entry.id === id))) return;
  if (on && previous.length >= (kind === 'league' ? 8 : 64)) {
    showErr(t('home.football.limit', 'Choose at most eight leagues and 64 teams.')); renderHomeWidgets(); return;
  }
  widgets.football[key] = on ? previous.concat([item]) : previous.filter(entry => entry.id !== id);
  if (!widgets.football.leagues.length && !widgets.football.teams.length) widgets.football.enabled = false;
  if (!homeFootballSources(widgets.football).some(league => league.id === homeFootballLeague)) homeFootballLeague = '';
  const scroll = q('home-football-' + kind)?.scrollTop || 0;
  await homeSaveLayout({ widgets });
  const host = q('home-football-' + kind);
  if (host) host.scrollTop = scroll;
  host?.querySelector(`[data-football-${kind}="${id}"]`)?.focus({ preventScroll: true });
}

function homeFootballClearTeams() {
  if (!homeWritable() || homeFootballBusy) return;
  const widgets = homeWidgetSettings(); widgets.football.teams = [];
  if (!widgets.football.leagues.length) widgets.football.enabled = false;
  homeSaveLayout({ widgets });
}
