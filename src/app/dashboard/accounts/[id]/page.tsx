'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import styles from '../accounts.module.css';

interface Account {
  id: string;
  name: string;
  email: string;
  joinMethod: string;
  joinedTimestamp: number;
}

interface Resource {
  type: string;
  region: string | null;
  count: number;
}

export default function AccountDetail() {
  const router = useRouter();
  const params = useParams();
  const accountId = params.id as string;

  const [account, setAccount] = useState<Account | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<string | undefined>(undefined);
  const [formData, setFormData] = useState<Partial<Account>>({});

  useEffect(() => {
    fetchAccount();
    fetchResources();
  }, [accountId]);

  const fetchAccount = async () => {
    try {
      const response = await fetch(`/api/accounts/${accountId}`);
      if (!response.ok) throw new Error('Account not found');
      const data = await response.json();
      setAccount(data);
      setFormData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const fetchResources = async () => {
    try {
      const response = await fetch(`/api/accounts/${accountId}/resources`);
      if (!response.ok) throw new Error('Failed to fetch resources');
      const data = await response.json();
      setResources(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleResourceClick = (resource: Resource) => {
    // Handle special resources
    if (resource.type === 'S3') {
      const regionParam = resource.region ? `?region=${encodeURIComponent(resource.region)}` : '';
      router.push(`/dashboard/accounts/${accountId}/resources/s3${regionParam}`);
      return;
    }
    if (resource.type === 'CloudTrail') {
      router.push(`/dashboard/accounts/${accountId}/cloudtrail`);
      return;
    }

    const regionParam = resource.region ? `?region=${encodeURIComponent(resource.region)}` : '';
    router.push(
      `/dashboard/accounts/${accountId}/resources/${resource.type.toLowerCase()}${regionParam}`
    );
  };

  const getUniqueRegions = (): (string | null)[] => {
    const regions = new Set<string | null>();
    resources.forEach((r) => {
      regions.add(r.region);
    });
    return Array.from(regions).sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    });
  };

  const getFilteredResources = (): Resource[] => {
    if (selectedRegion === undefined) return resources; // "All Regions" - show all
    if (selectedRegion === 'null') return resources.filter((r) => r.region === null); // Global resources
    return resources.filter((r) => r.region === selectedRegion);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleUpdate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) throw new Error('Failed to update account');
      const updated = await response.json();
      setAccount(updated);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete account "${account?.name}"? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete account');
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  if (loading || !account)
    return (
      <div className={styles.container}>
        <p>Loading...</p>
      </div>
    );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Link href="/dashboard" className={styles.backButton}>
          ← Back
        </Link>
        <h1>{account.name}</h1>
        <button className={styles.editButton} onClick={() => setIsEditing(!isEditing)}>
          {isEditing ? 'Cancel' : 'Edit'}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {isEditing ? (
        <form onSubmit={handleUpdate} className={styles.form}>
          <div className={styles.formGroup}>
            <label htmlFor="name">Account Name</label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name || ''}
              onChange={handleChange}
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email || ''}
              onChange={handleChange}
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="joinMethod">Join Method</label>
            <select
              id="joinMethod"
              name="joinMethod"
              value={formData.joinMethod || 'CREATED'}
              onChange={handleChange}
            >
              <option value="CREATED">Created</option>
              <option value="INVITED">Invited</option>
              <option value="IMPORTED">Imported</option>
            </select>
          </div>

          <div className={styles.formActions}>
            <button type="submit" className={styles.submitButton}>
              Save Changes
            </button>
            <button
              type="button"
              className={styles.deleteButton}
              onClick={handleDelete}
            >
              Delete Account
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.details}>
          <div className={styles.detailSection}>
            <h3>Account Information</h3>
            <div className={styles.detailRow}>
              <span className={styles.label}>Account ID:</span>
              <span className={styles.value}>{account.id}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.label}>Name:</span>
              <span className={styles.value}>{account.name}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.label}>Email:</span>
              <span className={styles.value}>{account.email}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.label}>Join Method:</span>
              <span className={styles.value}>{account.joinMethod}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.label}>Joined:</span>
              <span className={styles.value}>
                {new Date(account.joinedTimestamp).toLocaleString()}
              </span>
            </div>
          </div>

          <div className={styles.detailSection}>
            <h3>AWS Resources</h3>
            {resources.length > 0 ? (
              <>
                <div className={styles.regionSelector}>
                  <label htmlFor="region-filter">Filter by Region:</label>
                  <select
                    id="region-filter"
                    value={selectedRegion === undefined ? 'all' : selectedRegion}
                    onChange={(e) => {
                      if (e.target.value === 'all') setSelectedRegion(undefined);
                      else setSelectedRegion(e.target.value);
                    }}
                    className={styles.regionSelect}
                  >
                    <option value="all">All Regions</option>
                    {getUniqueRegions().map((region) => (
                      <option key={region ?? 'null'} value={region ?? 'null'}>
                        {region === null ? 'Global (AWS account-wide)' : region}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.resourcesList}>
                  {getFilteredResources().map((resource, idx) => (
                    <button
                      key={idx}
                      className={styles.resourceItem}
                      onClick={() => handleResourceClick(resource)}
                      title={`Click to view ${resource.type} details`}
                    >
                      <div className={styles.resourceType}>{resource.type}</div>
                      <div className={styles.resourceDetails}>
                        <span>{resource.region === null ? 'Global' : resource.region}</span>
                        <span className={styles.resourceCount}>{resource.count} resources</span>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className={styles.noResources}>No resources found in this account</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
