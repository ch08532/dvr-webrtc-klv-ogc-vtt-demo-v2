import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Modal, Paper, Select, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import CatalogMap from './CatalogMap.jsx';
import MissionCoverageThumbnail from './MissionCoverageThumbnail.jsx';

const productTypes = [
  { value: '', label: 'All product types' },
  { value: 'fmv', label: 'FMV' },
  { value: 'snapshot', label: 'Snapshots' },
  { value: 'clip', label: 'Clips' },
  { value: 'target-log', label: 'Target logs' }
];

const request = async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || `Request failed (${response.status})`);
  return data;
};

function bboxFromArea(area) {
  const points = [];
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]), Number(value[1])]);
      return;
    }
    value.forEach(collect);
  };
  collect(area?.coordinates);
  if (!points.length) return null;
  const longitudes = points.map(([lon]) => lon);
  const latitudes = points.map(([, lat]) => lat);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}

function coverageFromBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return null;
  const [west, south, east, north] = bbox;
  return {
    type: 'Polygon',
    coordinates: [[
      [west, south], [east, south], [east, north], [west, north], [west, south]
    ]]
  };
}

const MISSION_CONTEXT_SPLIT_MIN_PERCENT = 25;
const MISSION_CONTEXT_SPLIT_MAX_PERCENT = 60;

function clampMissionContextSplit(value) {
  return Math.min(MISSION_CONTEXT_SPLIT_MAX_PERCENT, Math.max(MISSION_CONTEXT_SPLIT_MIN_PERCENT, Math.round(Number(value))));
}

function MissionContextSplitHandle({ value, onChange }) {
  const beginDrag = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const workspace = handle.parentElement;
    if (!workspace) return;
    const update = (pointerEvent) => {
      const rect = workspace.getBoundingClientRect();
      if (!rect.width) return;
      onChange(clampMissionContextSplit(((pointerEvent.clientX - rect.left) / rect.width) * 100));
    };
    const endDrag = (pointerEvent) => {
      handle.removeEventListener('pointermove', update);
      handle.removeEventListener('pointerup', endDrag);
      handle.removeEventListener('pointercancel', endDrag);
      if (handle.hasPointerCapture?.(pointerEvent.pointerId)) handle.releasePointerCapture(pointerEvent.pointerId);
    };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', update);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    update(event);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onChange(clampMissionContextSplit(value - 5));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onChange(clampMissionContextSplit(value + 5));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(MISSION_CONTEXT_SPLIT_MIN_PERCENT);
    } else if (event.key === 'End') {
      event.preventDefault();
      onChange(MISSION_CONTEXT_SPLIT_MAX_PERCENT);
    }
  };

  return <button
    type="button"
    className="mission-context-split-handle"
    role="separator"
    aria-label="Resize mission list and map"
    aria-orientation="vertical"
    aria-valuemin={MISSION_CONTEXT_SPLIT_MIN_PERCENT}
    aria-valuemax={MISSION_CONTEXT_SPLIT_MAX_PERCENT}
    aria-valuenow={value}
    onPointerDown={beginDrag}
    onKeyDown={handleKeyDown}
  ><span aria-hidden="true" /></button>;
}

function AddIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

function CatalogActionIcon({ name }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (name === 'edit') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 3.5-.8L18 8.7a2.1 2.1 0 0 0-3-3l-9.5 9.5z" {...stroke} /><path d="m13.5 7.2 3.3 3.3" {...stroke} /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v5m4-5v5M9 7l1-2h4l1 2m-8 0 1 12h8l1-12" {...stroke} /></svg>;
}

function DraggableModal({ title, children, styles, ...props }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  const moveBy = (x, y) => setPosition((current) => ({ x: current.x + x, y: current.y + y }));
  const startDrag = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const drag = (event) => {
    const start = dragRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    moveBy(event.clientX - start.x, event.clientY - start.y);
    dragRef.current = { ...start, x: event.clientX, y: event.clientY };
  };
  const stopDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleKeyDown = (event) => {
    const step = event.shiftKey ? 30 : 10;
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveBy(-step, 0); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveBy(step, 0); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveBy(0, -step); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveBy(0, step); }
    else if (event.key === 'Home') { event.preventDefault(); setPosition({ x: 0, y: 0 }); }
  };

  return <Modal
    {...props}
    title={<div className="draggable-modal-title" tabIndex={0} aria-label={`Move ${title} dialog`} onPointerDown={startDrag} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={handleKeyDown}>{title}</div>}
    styles={{ ...styles, title: { width: '100%', ...(styles?.title || {}) }, inner: { transform: `translate(${position.x}px, ${position.y}px)`, ...(styles?.inner || {}) } }}
  >{children}</Modal>;
}

export default function MissionCatalog({ page = 'catalog', onStatus = () => {}, baseMap = 'streets', onBaseMapChange = () => {} }) {
  const [operations, setOperations] = useState([]);
  const [missions, setMissions] = useState([]);
  const [products, setProducts] = useState([]);
  const [operationId, setOperationId] = useState('');
  const [missionId, setMissionId] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [operationTitle, setOperationTitle] = useState('');
  const [operationDescription, setOperationDescription] = useState('');
  const [missionTitle, setMissionTitle] = useState('');
  const [missionDescription, setMissionDescription] = useState('');
  const [drawMissionArea, setDrawMissionArea] = useState(false);
  const [missionBbox, setMissionBbox] = useState(null);
  const [editingOperationId, setEditingOperationId] = useState(null);
  const [editingMissionId, setEditingMissionId] = useState(null);
  const [selectedContextMissionId, setSelectedContextMissionId] = useState(null);
  const [contextTab, setContextTab] = useState('missions');
  const [missionModalOpen, setMissionModalOpen] = useState(false);
  const [operationModalOpen, setOperationModalOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [resumeMissionAfterDraw, setResumeMissionAfterDraw] = useState(false);
  const [resumeMissionAfterOperation, setResumeMissionAfterOperation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [contextSplit, setContextSplit] = useState(35);
  const selectedMissionCardRef = useRef(null);

  const report = (message, color = 'green') => {
    setNotice({ message, color });
    onStatus(message);
  };

  const loadContext = useCallback(async () => {
    try {
      const [operationResult, missionResult] = await Promise.all([request('/mission-operations'), request('/missions')]);
      setOperations(operationResult.operations || []);
      setMissions(missionResult.missions || []);
    } catch (error) {
      report(`Catalog context error: ${error.message}`, 'red');
    }
  }, [onStatus]);

  const search = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (type) params.set('type', type);
      if (operationId) params.set('operationId', operationId);
      if (missionId) params.set('missionId', missionId);
      if (from || to) params.set('datetime', `${from ? from.toISOString() : '..'}/${to ? to.toISOString() : '..'}`);
      const result = await request(`/mission-products?${params}`);
      setProducts(result.products || []);
    } catch (error) {
      report(`Catalog search error: ${error.message}`, 'red');
    }
  }, [q, type, operationId, missionId, from, to, onStatus]);

  useEffect(() => { void loadContext(); }, [loadContext]);
  useEffect(() => { if (page === 'catalog') void search(); }, [page, search]);
  useEffect(() => {
    if (page !== 'context' || !selectedContextMissionId) return;
    selectedMissionCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [page, selectedContextMissionId, missions]);

  const missionOptions = useMemo(() => missions
    .filter((mission) => !operationId || mission.operationId === operationId)
    .map((mission) => ({ value: mission.id, label: `${mission.operationTitle} / ${mission.title}` })), [missions, operationId]);
  const selected = products.find((product) => product.id === selectedId) || null;
  const draftCoverageArea = useMemo(() => missionBbox ? { geometry: coverageFromBbox(missionBbox) } : null, [missionBbox]);
  const missionCoverageAreas = useMemo(() => missions.map((mission) => ({ id: mission.id, geometry: mission.area })), [missions]);

  const resetOperationForm = () => {
    setEditingOperationId(null);
    setOperationTitle('');
    setOperationDescription('');
  };

  const resetMissionForm = () => {
    setEditingMissionId(null);
    setMissionTitle('');
    setMissionDescription('');
    setMissionBbox(null);
    setDrawMissionArea(false);
  };

  const closeMissionModal = () => {
    setMissionModalOpen(false);
    setResumeMissionAfterDraw(false);
    resetMissionForm();
  };

  const openMissionModal = () => {
    resetMissionForm();
    setMissionModalOpen(true);
    setNotice(null);
  };

  const closeOperationModal = () => {
    setOperationModalOpen(false);
    resetOperationForm();
    if (resumeMissionAfterOperation) {
      setResumeMissionAfterOperation(false);
      setMissionModalOpen(true);
    }
  };

  const openOperationModal = ({ returnToMission = false } = {}) => {
    resetOperationForm();
    setResumeMissionAfterOperation(returnToMission);
    if (returnToMission) setMissionModalOpen(false);
    setOperationModalOpen(true);
    setNotice(null);
  };

  const submitOperation = async () => {
    const creating = !editingOperationId;
    setBusy(true);
    try {
      const result = await request(creating ? '/mission-operations' : `/mission-operations/${editingOperationId}`, {
        method: creating ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: operationTitle, description: operationDescription })
      });
      if (creating) setOperationId(result.id);
      closeOperationModal();
      await loadContext();
      report(creating ? 'Operation created.' : 'Operation updated.');
    } catch (error) {
      report(error.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const submitMission = async () => {
    const creating = !editingMissionId;
    setBusy(true);
    try {
      const result = await request(creating ? '/missions' : `/missions/${editingMissionId}`, {
        method: creating ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId, title: missionTitle, description: missionDescription, bbox: missionBbox })
      });
      setSelectedContextMissionId(result.id);
      closeMissionModal();
      await loadContext();
      report(creating ? 'Mission created.' : 'Mission updated.');
    } catch (error) {
      report(error.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const startEditingOperation = (operation) => {
    setEditingOperationId(operation.id);
    setOperationTitle(operation.title);
    setOperationDescription(operation.description || '');
    setOperationModalOpen(true);
    setResumeMissionAfterOperation(false);
    setNotice(null);
  };

  const startEditingMission = (mission) => {
    setEditingMissionId(mission.id);
    setSelectedContextMissionId(mission.id);
    setOperationId(mission.operationId);
    setMissionTitle(mission.title);
    setMissionDescription(mission.description || '');
    setMissionBbox(bboxFromArea(mission.area));
    setDrawMissionArea(false);
    setMissionModalOpen(true);
    setNotice(null);
  };

  const deleteOperation = async (operation) => {
    setBusy(true);
    try {
      await request(`/mission-operations/${operation.id}`, { method: 'DELETE' });
      if (operationId === operation.id) setOperationId('');
      if (editingOperationId === operation.id) resetOperationForm();
      await loadContext();
      report('Operation deleted.');
    } catch (error) {
      report(error.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const deleteMission = async (mission) => {
    setBusy(true);
    try {
      await request(`/missions/${mission.id}`, { method: 'DELETE' });
      if (missionId === mission.id) setMissionId('');
      if (editingMissionId === mission.id) resetMissionForm();
      if (selectedContextMissionId === mission.id) setSelectedContextMissionId(null);
      await loadContext();
      report('Mission deleted.');
    } catch (error) {
      report(error.message, 'red');
    } finally {
      setBusy(false);
    }
  };

  const openProduct = async (product) => {
    try {
      setViewer(await request(`/mission-products/${product.id}`));
    } catch (error) {
      report(error.message, 'red');
    }
  };

  if (page === 'context') {
    const canSubmitMission = !!operationId && !!missionTitle.trim() && !!missionBbox && !busy;
    const selectContextMission = (id) => {
      setContextTab('missions');
      setSelectedContextMissionId(id);
    };
    const confirmDelete = async () => {
      if (!pendingDelete) return;
      if (pendingDelete.kind === 'mission') await deleteMission(pendingDelete.item);
      else await deleteOperation(pendingDelete.item);
      setPendingDelete(null);
    };
    const beginCoverageDraw = () => {
      setMissionModalOpen(false);
      setResumeMissionAfterDraw(true);
      setDrawMissionArea(true);
    };
    return <Stack gap="md" className="catalog-workspace mission-context-page">
      <div>
        <Text size="xl" fw={700}>Mission Context</Text>
        <Text size="sm" c="dimmed">Create an operation first, then create, edit, or remove its missions and their coverage areas.</Text>
      </div>
      {notice ? <Text size="sm" c={notice.color}>{notice.message}</Text> : null}
      <div className="mission-context-workspace" style={{ '--mission-context-list-width': `${contextSplit}%` }}>
        <div className="mission-context-list-pane">
          <div className="mission-context-tabs" role="tablist" aria-label="Mission context data">
            <button type="button" role="tab" id="missions-tab" aria-controls="missions-panel" aria-selected={contextTab === 'missions'} className={contextTab === 'missions' ? 'is-active' : ''} onClick={() => setContextTab('missions')}>Missions</button>
            <button type="button" role="tab" id="operations-tab" aria-controls="operations-panel" aria-selected={contextTab === 'operations'} className={contextTab === 'operations' ? 'is-active' : ''} onClick={() => setContextTab('operations')}>Operations</button>
          </div>
          {contextTab === 'missions' ? <div className="mission-context-tab-panel" id="missions-panel" role="tabpanel" aria-labelledby="missions-tab">
            <Button className="mission-context-add-button" radius="xl" size="sm" leftSection={<AddIcon />} onClick={openMissionModal} disabled={busy}>Add Mission</Button>
            <Stack gap="xs" className="mission-context-item-list">
              {missions.length ? missions.map((mission) => <Paper key={mission.id} ref={mission.id === selectedContextMissionId ? selectedMissionCardRef : null} p="sm" withBorder aria-selected={mission.id === selectedContextMissionId} className={mission.id === selectedContextMissionId ? 'catalog-result mission-context-list-item is-selected' : 'catalog-result mission-context-list-item'} onClick={() => selectContextMission(mission.id)}>
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div className="mission-context-list-summary">
                    <MissionCoverageThumbnail geometry={mission.area} baseMap={baseMap} />
                    <div className="mission-context-item-copy">
                      <Text fw={600}>{mission.title}</Text>
                      <Text size="xs" c="dimmed">{mission.operationTitle}</Text>
                      <Text size="sm" c="dimmed" lineClamp={2}>{mission.description || 'No description'}</Text>
                    </div>
                  </div>
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label="Edit mission" withArrow><ActionIcon variant="subtle" size="sm" aria-label="Edit mission" onClick={(event) => { event.stopPropagation(); startEditingMission(mission); }} onKeyDown={(event) => event.stopPropagation()} disabled={busy}><CatalogActionIcon name="edit" /></ActionIcon></Tooltip>
                    <Tooltip label="Delete mission" withArrow><ActionIcon variant="subtle" color="red" size="sm" aria-label="Delete mission" onClick={(event) => { event.stopPropagation(); setPendingDelete({ kind: 'mission', item: mission }); }} onKeyDown={(event) => event.stopPropagation()} disabled={busy}><CatalogActionIcon name="remove" /></ActionIcon></Tooltip>
                  </Group>
                </Group>
              </Paper>) : <Text size="sm" c="dimmed">No missions yet.</Text>}
            </Stack>
          </div> : <div className="mission-context-tab-panel" id="operations-panel" role="tabpanel" aria-labelledby="operations-tab">
            <Button className="mission-context-add-button" radius="xl" size="sm" leftSection={<AddIcon />} onClick={() => openOperationModal()} disabled={busy}>Add Operation</Button>
            <Stack gap="xs" className="mission-context-item-list">
              {operations.length ? operations.map((operation) => <Paper key={operation.id} p="sm" withBorder>
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div className="mission-context-item-copy">
                    <Text fw={600}>{operation.title}</Text>
                    <Text size="sm" c="dimmed" lineClamp={3}>{operation.description || 'No description'}</Text>
                  </div>
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label="Edit operation" withArrow><ActionIcon variant="subtle" size="sm" aria-label="Edit operation" onClick={() => startEditingOperation(operation)} disabled={busy}><CatalogActionIcon name="edit" /></ActionIcon></Tooltip>
                    <Tooltip label="Delete operation" withArrow><ActionIcon variant="subtle" color="red" size="sm" aria-label="Delete operation" onClick={() => setPendingDelete({ kind: 'operation', item: operation })} disabled={busy}><CatalogActionIcon name="remove" /></ActionIcon></Tooltip>
                  </Group>
                </Group>
              </Paper>) : <Text size="sm" c="dimmed">No operations yet.</Text>}
            </Stack>
          </div>}
        </div>
        <MissionContextSplitHandle value={contextSplit} onChange={setContextSplit} />
        <div className="mission-context-map-pane">
          <CatalogMap
            coverageAreas={missionCoverageAreas}
            selectedCoverageAreaId={selectedContextMissionId}
            onCoverageAreaSelect={selectContextMission}
            draftCoverageArea={draftCoverageArea}
            baseMap={baseMap}
            onBaseMapChange={onBaseMapChange}
            showViewAllMissions
            drawing={drawMissionArea}
            onBboxDrawn={(bbox) => { setMissionBbox(bbox); setDrawMissionArea(false); if (resumeMissionAfterDraw) { setResumeMissionAfterDraw(false); setMissionModalOpen(true); } }}
          />
        </div>
      </div>
      <DraggableModal opened={missionModalOpen} onClose={closeMissionModal} title={editingMissionId ? 'Edit Mission' : 'Add Mission'} centered>
        <Stack gap="sm">
          <Group align="end" wrap="nowrap">
            <Select className="mission-operation-select" label="Operation" placeholder="Select an operation" data={operations.map((operation) => ({ value: operation.id, label: operation.title }))} value={operationId || null} onChange={(value) => { setOperationId(value || ''); setMissionId(''); }} />
            <Button aria-label="Add operation" title="Add operation" variant="light" size="sm" onClick={() => openOperationModal({ returnToMission: true })} disabled={busy}><AddIcon /></Button>
          </Group>
          <TextInput label="Name" value={missionTitle} onChange={(event) => setMissionTitle(event.currentTarget.value)} />
          <Textarea label="Description" value={missionDescription} onChange={(event) => setMissionDescription(event.currentTarget.value)} />
          <Group align="center">
            <Button variant="light" onClick={beginCoverageDraw} disabled={busy}>Draw coverage</Button>
            <Text size="sm" c={missionBbox ? 'green' : 'dimmed'}>{missionBbox ? 'Coverage area selected' : 'A coverage area is required'}</Text>
          </Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={closeMissionModal} disabled={busy}>Cancel</Button>
            <Button onClick={submitMission} disabled={!canSubmitMission}>{editingMissionId ? 'Save' : 'Create'}</Button>
          </Group>
        </Stack>
      </DraggableModal>
      <DraggableModal opened={operationModalOpen} onClose={closeOperationModal} title={editingOperationId ? 'Edit Operation' : 'Add Operation'} centered>
        <Stack gap="sm">
          <TextInput label="Name" value={operationTitle} onChange={(event) => setOperationTitle(event.currentTarget.value)} />
          <Textarea label="Description" value={operationDescription} onChange={(event) => setOperationDescription(event.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeOperationModal} disabled={busy}>Cancel</Button>
            <Button onClick={submitOperation} disabled={!operationTitle.trim() || busy}>{editingOperationId ? 'Save' : 'Create'}</Button>
          </Group>
        </Stack>
      </DraggableModal>
      <Modal opened={!!pendingDelete} onClose={() => { if (!busy) setPendingDelete(null); }} closeOnClickOutside={!busy} closeOnEscape={!busy} title={`Delete ${pendingDelete?.kind || ''}`} centered>
        <Stack gap="sm">
          <Text>Are you sure you want to delete {pendingDelete?.kind} “{pendingDelete?.item.title}”?</Text>
          <Text size="sm" c="dimmed">{pendingDelete?.kind === 'mission' ? 'This is only possible when the mission has no mission products.' : 'This is only possible when the operation has no missions.'}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPendingDelete(null)} disabled={busy}>No</Button>
            <Button color="red" onClick={() => void confirmDelete()} loading={busy}>Yes, delete</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>;
  }

  return <Stack gap="sm" className="catalog-workspace">
    <Text size="xl" fw={700}>Mission Products</Text>
    <Group align="end" className="catalog-filters">
      <TextInput label="Search" placeholder="Title, description, mission, operation" value={q} onChange={(event) => setQ(event.currentTarget.value)} />
      <Select label="Operation" clearable data={operations.map((operation) => ({ value: operation.id, label: operation.title }))} value={operationId || null} onChange={(value) => { setOperationId(value || ''); setMissionId(''); }} />
      <Select label="Mission" clearable data={missionOptions} value={missionId || null} onChange={(value) => setMissionId(value || '')} />
      <Select label="Type" data={productTypes} value={type} onChange={(value) => setType(value || '')} />
      <DateTimePicker label="From" value={from} onChange={setFrom} clearable />
      <DateTimePicker label="To" value={to} onChange={setTo} clearable />
      <Button onClick={search}>Search</Button>
    </Group>
    <div className="catalog-results-layout">
      <Stack gap="xs" className="catalog-results">
        {products.length ? products.map((product) => <Paper key={product.id} p="sm" withBorder className={product.id === selectedId ? 'catalog-result is-selected' : 'catalog-result'} onClick={() => setSelectedId(product.id)}>
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={2}>
              <Text fw={600}>{product.title}</Text>
              <Text size="xs" c="dimmed">{product.operationTitle} / {product.missionTitle}</Text>
              <Text size="sm" lineClamp={2}>{product.description || 'No description'}</Text>
            </Stack>
            <Badge>{product.type}</Badge>
          </Group>
          <Button size="xs" mt="xs" variant="subtle" onClick={(event) => { event.stopPropagation(); void openProduct(product); }}>Open product</Button>
        </Paper>) : <Text c="dimmed" p="md">No published mission products match the current filters.</Text>}
      </Stack>
      <CatalogMap products={products} selectedId={selectedId} onSelect={setSelectedId} />
    </div>
    <Modal opened={!!viewer} onClose={() => setViewer(null)} size="xl" title={viewer?.title}>
      {viewer?.type === 'snapshot' && viewer.thumbnailUrl ? <img className="catalog-image-viewer" src={viewer.thumbnailUrl} alt={viewer.title} /> : <Stack>
        <Badge>{viewer?.type}</Badge>
        <Text>{viewer?.description || 'No description'}</Text>
        <Text size="sm" c="dimmed">{viewer?.operationTitle} / {viewer?.missionTitle}</Text>
        {viewer?.assets?.map((asset) => <Button key={asset.href} component="a" href={asset.href} target="_blank" variant="light">Open {asset.type}</Button>)}
        {viewer?.geometry ? <Text size="sm">Coverage is displayed on the catalog map.</Text> : null}
      </Stack>}
    </Modal>
  </Stack>;
}
