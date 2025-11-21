import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './Wishlist.css';

const Wishlist = ({ onWishlistUpdate }) => {
  const [wishlistItems, setWishlistItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState([]);
  const [findingTime, setFindingTime] = useState(false);
  const [showMatches, setShowMatches] = useState(false);
  const [editingItemId, setEditingItemId] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', description: '', location: '' });
  const [newItemForm, setNewItemForm] = useState({ title: '', description: '', location: '' });
  const [addingItem, setAddingItem] = useState(false);
  const [itemSuggestions, setItemSuggestions] = useState({});

  useEffect(() => {
    fetchWishlistItems();
    // Auto-refresh every 30 seconds to remove past/scheduled items
    const interval = setInterval(fetchWishlistItems, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchWishlistItems = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/wishlist/items');
      if (response.data.success) {
        // Server automatically filters out past/scheduled items
        // Sort by createdAt (chronological order - oldest first)
        const items = (response.data.items || []).sort((a, b) => {
          const dateA = new Date(a.createdAt || 0);
          const dateB = new Date(b.createdAt || 0);
          return dateA - dateB; // Oldest first
        });
        setWishlistItems(items);
        
        // Notify parent of wishlist update
        if (onWishlistUpdate) {
          onWishlistUpdate(items);
        }
      }
    } catch (error) {
      console.error('Error fetching wishlist items:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteItem = async (itemId) => {
    try {
      await axios.delete(`/api/wishlist/items/${itemId}`);
      await fetchWishlistItems();
    } catch (error) {
      console.error('Error deleting wishlist item:', error);
      alert('Failed to delete wishlist item');
    }
  };

  const handleStartEdit = (item) => {
    setEditingItemId(item.id);
    setEditForm({
      title: item.title || '',
      description: item.description || '',
      location: item.location || ''
    });
  };

  const handleCancelEdit = () => {
    setEditingItemId(null);
    setEditForm({ title: '', description: '', location: '' });
  };

  const handleSaveEdit = async (itemId) => {
    try {
      const response = await axios.put(`/api/wishlist/items/${itemId}`, {
        title: editForm.title,
        description: editForm.description,
        location: editForm.location
      });

      if (response.data.success) {
        await fetchWishlistItems();
        setEditingItemId(null);
        setEditForm({ title: '', description: '', location: '' });
      } else {
        throw new Error(response.data.error || 'Failed to update item');
      }
    } catch (error) {
      console.error('Error updating wishlist item:', error);
      alert('Failed to update wishlist item. Please try again.');
    }
  };

  const handleAddItem = async () => {
    if (!newItemForm.title.trim()) {
      alert('Please enter a title for the wishlist item');
      return;
    }

    setAddingItem(true);
    try {
      const response = await axios.post('/api/wishlist/items', {
        title: newItemForm.title,
        description: newItemForm.description || null,
        location: newItemForm.location || null,
        priority: 'medium'
      });

      if (response.data.success) {
        await fetchWishlistItems();
        setNewItemForm({ title: '', description: '', location: '' });
        
        // Notify parent
        if (onWishlistUpdate) {
          await fetchWishlistItems();
          onWishlistUpdate(wishlistItems);
        }
      } else {
        throw new Error(response.data.error || 'Failed to add item');
      }
    } catch (error) {
      console.error('Error adding wishlist item:', error);
      alert('Failed to add wishlist item. Please try again.');
    } finally {
      setAddingItem(false);
    }
  };

  const handleFindTime = async () => {
    setFindingTime(true);
    setShowMatches(false);
    
    try {
      // Get current events
      const eventsResponse = await axios.get('/api/calendar/events');
      const events = eventsResponse.data.success ? eventsResponse.data.events : [];

      // Find time for wishlist items
      const response = await axios.post('/api/wishlist/find-time', {
        events: events,
        daysToCheck: 14
      });

      if (response.data.success && response.data.matches && response.data.matches.length > 0) {
        // Show top 3 matches
        setMatches(response.data.matches.slice(0, 3));
        setShowMatches(true);
      } else {
        alert('No free time slots found for wishlist items right now.');
      }
    } catch (error) {
      console.error('Error finding time:', error);
      alert('Failed to find time. Please try again.');
    } finally {
      setFindingTime(false);
    }
  };

  const handleScheduleMatch = async (match) => {
    try {
      const item = match.item;
      const startTime = new Date(match.suggestedStartTime || match.slot.startTime);
      
      const eventDetails = {
        title: item.title,
        date: startTime.toISOString().split('T')[0],
        time: startTime.toTimeString().slice(0, 5),
        duration: match.analysis?.estimatedDuration || 120,
        location: item.location || null,
        description: `Scheduled from wishlist: ${item.title}`
      };

      // Create event
      const createResponse = await axios.post('/api/voice/create-event', {
        eventDetails,
        tokens: null,
        override: false
      });

      if (createResponse.data.success) {
        // Delete from wishlist
        await axios.delete(`/api/wishlist/items/${item.id}`);
        await fetchWishlistItems();
        
        // Hide matches and refresh
        setShowMatches(false);
        setMatches([]);
        alert(`Scheduled "${item.title}"! It will be removed from wishlist automatically.`);
      } else {
        throw new Error(createResponse.data.error || 'Failed to schedule');
      }
    } catch (error) {
      console.error('Error scheduling match:', error);
      alert('Failed to schedule item. Please try again.');
    }
  };

  const updateItemSuggestionState = (itemId, updates) => {
    setItemSuggestions(prev => {
      const baseEntry = {
        suggestions: [],
        expanded: false,
        loading: false,
        error: null,
        info: null,
        bookingId: null,
        ...(prev[itemId] || {})
      };
      return {
        ...prev,
        [itemId]: {
          ...baseEntry,
          ...updates
        }
      };
    });
  };

  const fetchItemSuggestions = async (itemId) => {
    updateItemSuggestionState(itemId, { loading: true, error: null, info: null });
    try {
      const response = await axios.post(`/api/wishlist/items/${itemId}/suggestions`);
      const suggestions = response.data.suggestions || [];
      updateItemSuggestionState(itemId, {
        loading: false,
        suggestions,
        error: suggestions.length === 0 && response.data.error ? response.data.error : null,
        info: suggestions.length === 0 ? (response.data.message || 'No suggestions available right now.') : null
      });
    } catch (error) {
      const message = error.response?.status === 401
        ? 'Connect Google Calendar to get scheduling suggestions.'
        : (error.response?.data?.error || 'Failed to fetch suggestions.');
      updateItemSuggestionState(itemId, { loading: false, error: message });
    }
  };

  const toggleItemSuggestions = (itemId) => {
    const entry = itemSuggestions[itemId];
    const nextExpanded = !(entry?.expanded);
    updateItemSuggestionState(itemId, { expanded: nextExpanded });
    if (nextExpanded && !(entry?.suggestions?.length)) {
      fetchItemSuggestions(itemId);
    }
  };

  const handleRefreshSuggestions = (itemId) => {
    fetchItemSuggestions(itemId);
  };

  const handleScheduleSuggestion = async (item, suggestion) => {
    updateItemSuggestionState(item.id, { bookingId: suggestion.id, error: null });
    try {
      const start = new Date(suggestion.startTime);
      if (Number.isNaN(start.getTime())) {
        throw new Error('Invalid suggestion start time');
      }
      const duration = suggestion.durationMinutes || Math.max(60, Math.round(((new Date(suggestion.endTime)) - start) / 60000));

      const eventDetails = {
        title: item.title,
        date: start.toISOString().split('T')[0],
        time: start.toTimeString().slice(0, 5),
        duration,
        location: item.location || null,
        description: `Scheduled from wishlist: ${item.title}${item.description ? `\n\nDetails: ${item.description}` : ''}`
      };

      const response = await axios.post('/api/voice/create-event', {
        eventDetails,
        override: false
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to create calendar event');
      }

      await axios.delete(`/api/wishlist/items/${item.id}`);
      updateItemSuggestionState(item.id, { suggestions: [], expanded: false, bookingId: null });
      await fetchWishlistItems();
      alert(`Scheduled "${item.title}"!`);
    } catch (error) {
      const message = error.response?.data?.error || error.message || 'Failed to schedule item.';
      updateItemSuggestionState(item.id, { bookingId: null, error: message });
    }
  };

  if (loading) {
    return (
      <div className="wishlist-container">
        <div className="loading">Loading wishlist...</div>
      </div>
    );
  }

  return (
    <div className="wishlist-container">
      <div className="wishlist-header">
        <h2>🌟 My Wishlist</h2>
        <button
          className="find-time-btn-primary"
          onClick={handleFindTime}
          disabled={wishlistItems.length === 0 || findingTime}
        >
          {findingTime ? '🔍 Finding...' : '🔍 Find Time'}
        </button>
      </div>

      {/* Manual Add Item Form */}
      <div className="add-item-section">
        <h3>Add New Item</h3>
        <div className="add-item-form">
          <input
            type="text"
            className="add-item-input"
            value={newItemForm.title}
            onChange={(e) => setNewItemForm({ ...newItemForm, title: e.target.value })}
            placeholder="Enter item title (e.g., Visit art museum)"
            onKeyPress={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAddItem();
              }
            }}
          />
          <input
            type="text"
            className="add-item-input"
            value={newItemForm.location || ''}
            onChange={(e) => setNewItemForm({ ...newItemForm, location: e.target.value })}
            placeholder="Location (optional)"
            onKeyPress={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAddItem();
              }
            }}
          />
          <textarea
            className="add-item-textarea"
            value={newItemForm.description || ''}
            onChange={(e) => setNewItemForm({ ...newItemForm, description: e.target.value })}
            placeholder="Description (optional)"
            rows="2"
          />
          <button
            className="add-item-submit-btn"
            onClick={handleAddItem}
            disabled={addingItem || !newItemForm.title.trim()}
          >
            {addingItem ? '⏳ Adding...' : '➕ Add to Wishlist'}
          </button>
        </div>
        <p className="add-item-hint">
          💡 You can also use the Voice Assistant (🎤 button in header) to add items by voice
        </p>
      </div>

      {showMatches && matches.length > 0 && (
        <div className="matches-section">
          <h3>✨ Suggested Times</h3>
          <div className="matches-list">
            {matches.map((match, index) => {
              const item = match.item;
              const startTime = new Date(match.suggestedStartTime || match.slot.startTime);
              const dateStr = startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
              const timeStr = startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
              const duration = match.analysis?.estimatedDuration || 120;
              
              return (
                <div key={index} className="match-card">
                  <div className="match-info">
                    <h4>{item.title}</h4>
                    {match.suggestionMessage ? (
                      <p className="suggestion-message">{match.suggestionMessage}</p>
                    ) : (
                      <p className="match-time">{dateStr} at {timeStr}</p>
                    )}
                    {match.analysis?.reasoning && (
                      <p className="match-reasoning">{match.analysis.reasoning}</p>
                    )}
                    <div className="match-details">
                      <span className="duration-badge">⏱️ ~{duration} min</span>
                      {item.location && <span className="location-badge">📍 {item.location}</span>}
                    </div>
                  </div>
                  <button
                    className="schedule-match-btn"
                    onClick={() => handleScheduleMatch(match)}
                  >
                    ✅ Schedule
                  </button>
                </div>
              );
            })}
          </div>
          <button className="dismiss-matches-btn" onClick={() => { setShowMatches(false); setMatches([]); }}>
            Dismiss
          </button>
        </div>
      )}

      {wishlistItems.length === 0 ? (
        <div className="empty-wishlist">
          <p>Your wishlist is empty!</p>
          <p className="hint">💡 Use voice commands like "I want to visit the art museum someday" to add items</p>
        </div>
      ) : (
        <div className="wishlist-list">
          {wishlistItems.map(item => {
            const isEditing = editingItemId === item.id;
            return (
              <div key={item.id} className={`wishlist-item ${isEditing ? 'editing' : ''}`}>
                {isEditing ? (
                  <div className="edit-item-form">
                    <input
                      type="text"
                      className="edit-item-input"
                      value={editForm.title}
                      onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                      placeholder="Title"
                    />
                    <input
                      type="text"
                      className="edit-item-input"
                      value={editForm.location || ''}
                      onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
                      placeholder="Location (optional)"
                    />
                    <textarea
                      className="edit-item-textarea"
                      value={editForm.description || ''}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      placeholder="Description (optional)"
                      rows="3"
                    />
                    <div className="edit-item-actions">
                      <button
                        className="save-edit-btn"
                        onClick={() => handleSaveEdit(item.id)}
                      >
                        ✓ Save
                      </button>
                      <button
                        className="cancel-edit-btn"
                        onClick={handleCancelEdit}
                      >
                        ✗ Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {(() => {
                      const entry = itemSuggestions[item.id] || {
                        suggestions: [],
                        expanded: false,
                        loading: false,
                        error: null,
                        info: null,
                        bookingId: null
                      };
                      const startSuggestions = entry.suggestions || [];

                      return (
                        <>
                          <div className="item-content">
                            <h4>{item.title}</h4>
                            {item.location && <p className="item-location">📍 {item.location}</p>}
                            {item.description && <p className="item-description">{item.description}</p>}
                            <p className="item-date">Added: {new Date(item.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}</p>

                            <div className="item-suggestions">
                              <button
                                className="suggestions-toggle-btn"
                                onClick={() => toggleItemSuggestions(item.id)}
                                disabled={entry.loading && !entry.expanded}
                              >
                                {entry.expanded ? 'Hide Suggestions' : 'Show Suggestions'}
                              </button>
                              {entry.expanded && (
                                <div className="suggestions-panel">
                                  <div className="suggestions-header">
                                    <span>Scheduling ideas for this week</span>
                                    <button
                                      className="suggestions-refresh-btn"
                                      onClick={() => handleRefreshSuggestions(item.id)}
                                      disabled={entry.loading}
                                      title="Refresh suggestions"
                                    >
                                      🔄 Refresh
                                    </button>
                                  </div>
                                  {entry.loading ? (
                                    <p className="suggestions-loading">Loading suggestions...</p>
                                  ) : (
                                    <>
                                      {entry.error && (
                                        <p className="suggestions-error">{entry.error}</p>
                                      )}
                                      {entry.info && !entry.error && (
                                        <p className="suggestions-info">{entry.info}</p>
                                      )}
                                      {startSuggestions.length > 0 && (
                                        <div className="suggestions-list">
                                          {startSuggestions.map((suggestion) => {
                                            const startTime = new Date(suggestion.startTime);
                                            const endTime = suggestion.endTime ? new Date(suggestion.endTime) : null;
                                            const dateLabel = startTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                                            const timeLabel = startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                                            const durationLabel = suggestion.durationMinutes || (endTime ? Math.round((endTime - startTime) / 60000) : null);
                                            const isBooking = entry.bookingId === suggestion.id;

                                            return (
                                              <div key={suggestion.id} className="suggestion-card">
                                                <div className="suggestion-info">
                                                  <div className="suggestion-time">{dateLabel} • {timeLabel}</div>
                                                  {durationLabel && (
                                                    <div className="suggestion-duration">⏱️ ~{durationLabel} min</div>
                                                  )}
                                                  <p className="suggestion-message">{suggestion.message || suggestion.reasoning}</p>
                                                  {suggestion.reasoning && suggestion.message && (
                                                    <p className="suggestion-reasoning">{suggestion.reasoning}</p>
                                                  )}
                                                </div>
                                                <button
                                                  className="suggestion-schedule-btn"
                                                  onClick={() => handleScheduleSuggestion(item, suggestion)}
                                                  disabled={isBooking}
                                                >
                                                  {isBooking ? 'Scheduling…' : 'Add to Calendar'}
                                                </button>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="item-actions">
                            <button
                              className="edit-item-btn"
                              onClick={() => handleStartEdit(item)}
                              title="Edit"
                            >
                              ✏️
                            </button>
                            <button
                              className="delete-item-btn"
                              onClick={() => handleDeleteItem(item.id)}
                              title="Delete"
                            >
                              ×
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="wishlist-info">
        <p>💡 Items are automatically removed when scheduled or past their date</p>
        <p className="item-count">{wishlistItems.length} item{wishlistItems.length !== 1 ? 's' : ''} in wishlist</p>
      </div>
    </div>
  );
};

export default Wishlist;
