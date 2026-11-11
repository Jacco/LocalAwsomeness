'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../../accounts.module.css';

interface CloudTrailEvent {
  timestamp: string;
  principal: string;
  service: string;
  action: string;
  resource: string;
  authorizationDecision: string;
  account: string;
  region: string;
  parameters?: any;
}

export default function CloudTrailPage() {
  const params = useParams();
  const accountId = typeof params.id === 'string' ? params.id : params.id?.[0] || '';

  const [events, setEvents] = useState<CloudTrailEvent[]>([]);
  const [filteredEvents, setFilteredEvents] = useState<CloudTrailEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterService, setFilterService] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterResource, setFilterResource] = useState('');

  useEffect(() => {
    fetchEvents();
  }, [accountId]);

  useEffect(() => {
    filterEvents();
  }, [events, filterService, filterAction, filterResource]);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/accounts/${accountId}/cloudtrail`);
      if (!response.ok) throw new Error('Failed to fetch events');
      const data = await response.json();
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const filterEvents = () => {
    let filtered = events;

    if (filterService) {
      filtered = filtered.filter(e => 
        e.service.toLowerCase().includes(filterService.toLowerCase())
      );
    }

    if (filterAction) {
      filtered = filtered.filter(e => 
        e.action.toLowerCase().includes(filterAction.toLowerCase())
      );
    }

    if (filterResource) {
      filtered = filtered.filter(e => 
        e.resource.toLowerCase().includes(filterResource.toLowerCase())
      );
    }

    setFilteredEvents(filtered);
  };

  const uniqueServices = [...new Set(events.map(e => e.service))];
  const uniqueActions = [...new Set(events.map(e => e.action))];

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>
            ← Back
          </Link>
          <h1>Loading CloudTrail Events...</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>
            ← Back
          </Link>
          <h1>CloudTrail Events</h1>
        </div>
        <p style={{ color: 'red' }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Link href={`/dashboard/accounts/${accountId}`} className={styles.backButton}>
          ← Back to Account
        </Link>
        <h1>CloudTrail Events ({filteredEvents.length} of {events.length})</h1>
      </div>

      {/* Filters */}
      <div className={styles.resourceForm} style={{ marginBottom: '24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
          <div className={styles.formGroup}>
            <label htmlFor="filterService">Service</label>
            <select
              id="filterService"
              value={filterService}
              onChange={(e) => setFilterService(e.target.value)}
            >
              <option value="">All Services</option>
              {uniqueServices.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="filterAction">Action</label>
            <select
              id="filterAction"
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value)}
            >
              <option value="">All Actions</option>
              {uniqueActions.map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="filterResource">Resource</label>
            <input
              id="filterResource"
              type="text"
              placeholder="Filter by resource..."
              value={filterResource}
              onChange={(e) => setFilterResource(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Events Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '0.85em',
        }}>
          <thead>
            <tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '12px', textAlign: 'left' }}>Timestamp</th>
              <th style={{ padding: '12px', textAlign: 'left' }}>Service</th>
              <th style={{ padding: '12px', textAlign: 'left' }}>Action</th>
              <th style={{ padding: '12px', textAlign: 'left' }}>Resource</th>
              <th style={{ padding: '12px', textAlign: 'left' }}>Principal</th>
              <th style={{ padding: '12px', textAlign: 'center' }}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {filteredEvents.map((event, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '12px' }}>
                  {new Date(event.timestamp).toLocaleString()}
                </td>
                <td style={{ padding: '12px' }}>
                  <span style={{
                    backgroundColor: '#e3f2fd',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontWeight: 500,
                  }}>
                    {event.service}
                  </span>
                </td>
                <td style={{ padding: '12px', fontFamily: 'monospace' }}>
                  {event.action}
                </td>
                <td style={{ padding: '12px', maxWidth: '200px', wordBreak: 'break-word' }}>
                  {event.resource}
                </td>
                <td style={{ padding: '12px', maxWidth: '250px', wordBreak: 'break-word', fontSize: '0.75em' }}>
                  {event.principal}
                </td>
                <td style={{
                  padding: '12px',
                  textAlign: 'center',
                  fontWeight: 'bold',
                  color: event.authorizationDecision === 'allow' ? '#4caf50' : '#f44336',
                }}>
                  {event.authorizationDecision.toUpperCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filteredEvents.length === 0 && (
        <p style={{ marginTop: '24px', color: '#999' }}>
          No events match the current filters
        </p>
      )}
    </div>
  );
}
