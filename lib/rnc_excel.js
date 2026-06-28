// lib/rnc_excel.js — gera a RNC (TEM-18) preenchendo o template real (preserva layout/logos).
const ExcelJS = require('exceljs');
const { RNC_TEMPLATE_B64, PLANO_TEMPLATE_B64 } = require('./rnc_templates');

function fmtBR(v) {
  const m = String(v || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3] + '/' + m[2] + '/' + m[1]) : (v || '');
}

async function buildRncXlsx(rec) {
  rec = rec || {};
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(RNC_TEMPLATE_B64, 'base64'));
  const ws = wb.getWorksheet('RNC');
  const set = function (addr, val) {
    if (val == null || val === '') return;
    try { ws.getCell(addr).value = val; } catch (e) {}
  };

  set('A3', 'RNC N°:  ' + (rec.num || ''));
  set('H5', rec.cliente || '');
  set('H6', rec.emitente || '');
  set('H7', rec.dataEmissao || '');
  set('AU11', rec.setor || '');
  set('A14', rec.equipe || '');
  set('A18', rec.descricao || '');
  set('A23', rec.contencao || '');

  // D4 — Causa raiz (Ishikawa / 6M) nos quadros do diagrama
  const c = rec.causaRaiz;
  if (c && typeof c === 'object') {
    set('AL29', c.metodo || '');
    set('T29', c.maquina || '');
    set('B29', c.medicao || '');
    set('T41', c.maoObra || '');
    set('B41', c.material || '');
    set('AL41', c.meioAmbiente || '');
  } else if (c) {
    set('B29', c);
  }

  // helper: preenche linhas de ação (Ação | Responsável | Data)
  const fillRows = function (arr, rowsList) {
    (Array.isArray(arr) ? arr : []).slice(0, rowsList.length).forEach(function (a, i) {
      const rw = rowsList[i];
      set('A' + rw, a.acao || '');
      set('AI' + rw, a.resp || '');
      set('AP' + rw, fmtBR(a.prazo));
    });
  };
  fillRows(rec.acoesCorrecao, [44, 45, 46, 47]); // D5
  fillRows(rec.implementacao, [50, 51]);         // D6
  fillRows(rec.preventivas, [54, 55]);           // D7

  set('A58', rec.eficacia || ''); // D8

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// Plano de Acao (TEM-15) — preenche o template real sem alterar o layout.
// Cabecalho: C3=Data criacao, F3=Responsavel, I3=Objetivo. Linhas 9..16 (8 acoes).
// Colunas: A=N, B=O que (NC), D=Por que (causas), E=Como (acao), F=Quem, H=Quando(Fim), I=Onde, M=Eficacia.
async function buildPlanoXlsx(rec) {
  rec = rec || {};
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(PLANO_TEMPLATE_B64, 'base64'));
  const ws = wb.getWorksheet('PLANO DE A\u00c7\u00c3O') || wb.worksheets[0];
  const set = function (addr, val) {
    if (val == null || val === '') return;
    try { ws.getCell(addr).value = val; } catch (e) {}
  };
  set('C3', fmtBR(rec.dataEmissao));
  set('F3', rec.emitente || '');
  set('I3', 'Tratar a nao conformidade RNC N ' + (rec.num || '') + (rec.setor ? ' - ' + rec.setor : ''));
  var causas = '';
  var c = rec.causaRaiz;
  if (c && typeof c === 'object') {
    var map = [['Metodo', c.metodo], ['Maquina', c.maquina], ['Medicao', c.medicao], ['Mao de obra', c.maoObra], ['Material', c.material], ['Meio ambiente', c.meioAmbiente]];
    causas = map.filter(function (m) { return m[1]; }).map(function (m) { return m[0] + ': ' + m[1]; }).join('\n');
  } else if (c) { causas = String(c); }
  var join = function (arr) { return Array.isArray(arr) ? arr : []; };
  var acoes = [].concat(join(rec.acoesCorrecao), join(rec.implementacao), join(rec.preventivas))
    .filter(function (a) { return a && (a.acao || a.resp || a.prazo); });
  var ROWS = [9, 10, 11, 12, 13, 14, 15, 16];
  acoes.slice(0, ROWS.length).forEach(function (a, i) {
    var rw = ROWS[i];
    set('A' + rw, i + 1);
    set('E' + rw, a.acao || '');
    set('F' + rw, a.resp || '');
    set('H' + rw, fmtBR(a.prazo));
    if (i === 0) {
      set('B' + rw, rec.descricao || '');
      set('D' + rw, causas);
      set('I' + rw, rec.setor || '');
      if (rec.eficacia) set('M' + rw, rec.eficacia);
    }
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}


// Plano de Acao (TEM-15) a partir das Oportunidades de Melhoria (grau C) da auditoria.
async function buildPlanoOMXlsx(data) {
  data = data || {};
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(PLANO_TEMPLATE_B64, 'base64'));
  const ws = wb.getWorksheet('PLANO DE A\u00c7\u00c3O') || wb.worksheets[0];
  const set = function (addr, val) {
    if (val == null || val === '') return;
    try { ws.getCell(addr).value = val; } catch (e) {}
  };
  set('C3', data.data || '');
  set('F3', data.auditor || '');
  set('I3', 'Oportunidades de melhoria (Grau C)' + (data.empresa ? ' - ' + data.empresa : ''));
  var items = Array.isArray(data.items) ? data.items : [];
  var ROWS = [9, 10, 11, 12, 13, 14, 15, 16];
  items.slice(0, ROWS.length).forEach(function (it, i) {
    var rw = ROWS[i];
    var oque = (it.clausula ? it.clausula + ' - ' : '') + (it.requisito || '');
    var obs = it.comentario || it.evidencia || '';
    if (obs) oque += '\nObs.: ' + obs;
    set('A' + rw, i + 1);
    set('B' + rw, oque);
    set('F' + rw, it.responsavel || '');
    set('I' + rw, it.setor || '');
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildRncXlsx, buildPlanoXlsx, buildPlanoOMXlsx };
