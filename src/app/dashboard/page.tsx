'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from './dashboard.module.css';

interface Account {
  id: string;
  name: string;
  email: string;
  joinMethod: string;
  joinedTimestamp: number;
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/accounts');
      if (!response.ok) throw new Error('Failed to fetch accounts');
      const data = await response.json();
      setAccounts(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className={styles.container}><p>Loading...</p></div>;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>AWS Resource Dashboard</h1>
        <Link href="/dashboard/accounts/new" className={styles.button}>
          + Add Account
        </Link>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.grid}>
        {accounts.map((account) => (
          <Link key={account.id} href={`/dashboard/accounts/${account.id}`}>
            <div className={styles.card}>
              <h3>{account.name}</h3>
              <p className={styles.accountId}>{account.id}</p>
              <p className={styles.email}>{account.email}</p>
              <div className={styles.meta}>
                <span className={styles.method}>{account.joinMethod}</span>
                <span className={styles.date}>
                  {new Date(account.joinedTimestamp).toLocaleDateString()}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {accounts.length === 0 && !error && (
        <div className={styles.empty}>
          <p>No accounts found</p>
          <Link href="/dashboard/accounts/new" className={styles.button}>
            Create your first account
          </Link>
        </div>
      )}
    </div>
  );
}
