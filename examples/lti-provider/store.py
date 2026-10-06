"""
Database for the LTI tool: SQLite by default, PostgreSQL in production.

    DATABASE_URL=sqlite:///lti_data.db                          (default)
    DATABASE_URL=postgresql+psycopg://user:pass@host/dbname

Tables
    platforms  one row per connected LMS (issuer + client_id); this is the tenant
    launches   one row per LTI launch: who, which activity, where to send the grade
    scores     every score a student got, and whether the LMS accepted it
    contents   which platform owns which H5P content (tenant isolation)
    cache      short-lived pylti1p3 data (OIDC state, nonces, launch data)
"""

import json
import os
import time

from sqlalchemy import (
    Column, DateTime, Float, ForeignKey, Integer, MetaData, String, Table, Text, UniqueConstraint,
    create_engine, delete, func, insert, select, update,
)

DATABASE_URL = os.environ.get('DATABASE_URL', 'sqlite:///' + os.path.join(os.path.dirname(__file__), 'lti_data.db'))

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
metadata = MetaData()

platforms = Table(
    'platforms', metadata,
    Column('id', Integer, primary_key=True),
    Column('issuer', String(255), nullable=False),
    Column('client_id', String(255), nullable=False),
    Column('name', String(255)),
    Column('auth_login_url', Text, nullable=False),
    Column('auth_token_url', Text, nullable=False),
    Column('auth_audience', Text),
    Column('key_set_url', Text, nullable=False),
    Column('deployment_ids', Text, nullable=False, default='[]'),   # JSON list
    Column('created_at', DateTime, server_default=func.now()),
    UniqueConstraint('issuer', 'client_id'),
)

launches = Table(
    'launches', metadata,
    Column('launch_id', String(128), primary_key=True),
    Column('platform_id', Integer, ForeignKey('platforms.id'), nullable=False),
    Column('deployment_id', String(255)),
    Column('user_id', String(255), nullable=False),
    Column('resource_link_id', String(255)),
    Column('h5p_content_id', String(64)),
    Column('is_instructor', Integer, nullable=False, default=0),
    Column('ags_claim', Text),            # JSON: scope, lineitems, lineitem
    Column('created_at', DateTime, server_default=func.now()),
)

scores = Table(
    'scores', metadata,
    Column('id', Integer, primary_key=True),
    Column('launch_id', String(128), ForeignKey('launches.launch_id'), nullable=False),
    Column('score', Float, nullable=False),
    Column('max_score', Float, nullable=False),
    Column('sent_to_lms', Integer, nullable=False, default=0),
    Column('error', Text),
    Column('created_at', DateTime, server_default=func.now()),
)

contents = Table(
    'contents', metadata,
    Column('content_id', String(64), primary_key=True),
    Column('platform_id', Integer, ForeignKey('platforms.id'), nullable=False),
    Column('title', Text),
    Column('created_by', String(255)),
    Column('created_at', DateTime, server_default=func.now()),
)

cache = Table(
    'cache', metadata,
    Column('key', String(255), primary_key=True),
    Column('value', Text, nullable=False),
    Column('expires_at', Integer, nullable=False),
)


def init_db():
    metadata.create_all(engine)


def _row(result):
    row = result.mappings().first()
    return dict(row) if row else None


# --- Platforms ------------------------------------------------------------------

def find_platform(issuer, client_id=None):
    query = select(platforms).where(platforms.c.issuer == issuer)
    if client_id:
        query = query.where(platforms.c.client_id == client_id)
    with engine.connect() as conn:
        rows = conn.execute(query).mappings().all()
    # Without client_id the issuer must be unambiguous
    return dict(rows[0]) if len(rows) == 1 else None


def get_platform(platform_id):
    with engine.connect() as conn:
        return _row(conn.execute(select(platforms).where(platforms.c.id == platform_id)))


def list_platforms():
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(select(platforms).order_by(platforms.c.id)).mappings()]


def save_platform(issuer, client_id, auth_login_url, auth_token_url, key_set_url,
                  deployment_ids, name=None, auth_audience=None):
    """Add a platform, or update the one with this issuer and client_id. Returns its id."""
    values = dict(name=name, auth_login_url=auth_login_url, auth_token_url=auth_token_url,
                  key_set_url=key_set_url, auth_audience=auth_audience)
    with engine.begin() as conn:
        existing = _row(conn.execute(select(platforms).where(
            platforms.c.issuer == issuer, platforms.c.client_id == client_id)))
        if existing:
            known = json.loads(existing['deployment_ids'])
            values['deployment_ids'] = json.dumps(known + [d for d in deployment_ids if d not in known])
            conn.execute(update(platforms).where(platforms.c.id == existing['id']).values(**values))
            return existing['id']
        values['deployment_ids'] = json.dumps(list(deployment_ids))
        return conn.execute(insert(platforms).values(issuer=issuer, client_id=client_id, **values)).inserted_primary_key[0]


# --- Launches and grades --------------------------------------------------------

def save_launch(**values):
    with engine.begin() as conn:
        conn.execute(delete(launches).where(launches.c.launch_id == values['launch_id']))
        conn.execute(insert(launches).values(**values))


def get_launch(launch_id):
    with engine.connect() as conn:
        return _row(conn.execute(select(launches).where(launches.c.launch_id == launch_id)))


def add_grade(launch_id, score, max_score):
    with engine.begin() as conn:
        return conn.execute(insert(scores).values(
            launch_id=launch_id, score=score, max_score=max_score)).inserted_primary_key[0]


def mark_grade(grade_id, sent, error=None):
    with engine.begin() as conn:
        conn.execute(update(scores).where(scores.c.id == grade_id).values(sent_to_lms=int(sent), error=error))


def unsent_grades():
    """Grades the LMS has not accepted yet, with their launch, oldest first."""
    query = (select(scores.c.id, scores.c.score, scores.c.max_score, launches)
             .join(launches, scores.c.launch_id == launches.c.launch_id)
             .where(scores.c.sent_to_lms == 0).order_by(scores.c.id))
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(query).mappings()]


# --- Content ownership ----------------------------------------------------------

def claim_content(content_id, platform_id, title, created_by):
    """Record that a platform owns content. Content already owned by another platform is refused."""
    with engine.begin() as conn:
        owner = _row(conn.execute(select(contents).where(contents.c.content_id == content_id)))
        if owner and owner['platform_id'] != platform_id:
            return False
        if owner:
            conn.execute(update(contents).where(contents.c.content_id == content_id).values(title=title))
        else:
            conn.execute(insert(contents).values(
                content_id=content_id, platform_id=platform_id, title=title, created_by=created_by))
        return True


def platform_contents(platform_id):
    query = select(contents).where(contents.c.platform_id == platform_id).order_by(contents.c.created_at.desc())
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(query).mappings()]


def content_owner(content_id):
    with engine.connect() as conn:
        row = _row(conn.execute(select(contents.c.platform_id).where(contents.c.content_id == content_id)))
    return row['platform_id'] if row else None


# --- Cache for pylti1p3 ---------------------------------------------------------

class DbCache:
    """The get/set/delete cache that pylti1p3's CacheDataStorage expects, kept in the database."""
    DEFAULT_SECONDS = 7200

    def get(self, key):
        with engine.connect() as conn:
            row = _row(conn.execute(select(cache).where(cache.c.key == key, cache.c.expires_at > int(time.time()))))
        return json.loads(row['value']) if row else None

    def set(self, key, value, exp=None):
        now = int(time.time())
        with engine.begin() as conn:
            conn.execute(delete(cache).where((cache.c.key == key) | (cache.c.expires_at < now)))
            conn.execute(insert(cache).values(key=key, value=json.dumps(value),
                                              expires_at=now + (exp or self.DEFAULT_SECONDS)))

    def delete(self, key):
        with engine.begin() as conn:
            conn.execute(delete(cache).where(cache.c.key == key))
