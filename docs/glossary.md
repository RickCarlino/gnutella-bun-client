# Glossary

This glossary derives from the old [Online Manual](/manual/). More terms are being included. Some definitions derive from the [Gnutella Protocol Development draft](http://rfc-gnutella.sourceforge.net/src/rfc-0%5F6-draft.html).

## B

### Bandwidth _hint_ for GUESS querying

This is termes _bandwidth hint_ because GUESS uses UDP and cannot fraction large messages to emit just a few bytes. Therefore, the bandwidth is just a hint because it can be exceeded if a set of queries need to be made and their total amount exceeds the allocated bandwidth. Lower values means we can send less queries, and therefore the overall querying is slowed down (meaning the total querying will take longer) because each query is sent to _one_ GUESS ultrapeer.

### Bootstrap

The process of joining the Gnutella network by discovering peers is called bootstrapping. More informations [here](?page=bootstrap).

### Bucket (of a routing table)

A _bucket_ is a portion of the node ID space covered by the routing table. Each bucket can only hold K nodes, currently eight, before becoming "full". When a bucket is full of known good nodes, no more nodes may be added unless our own node ID falls within the range of the bucket. In that case, the bucket is replaced by two new buckets each with half the range of the old bucket and the nodes from the old bucket are distributed among the two new ones. This is called "bucket SPLIT". The opposite operation involving buckets is called MERGE.
Every node maintains a routing table of known good nodes. The nodes in the routing table are used as starting points for queries in the DHT. Nodes from the routing table are returned in response to queries from other nodes. It is important that each node's routing table must contain only known good nodes. A good node is a node has responded to one of our queries within the last 15 minutes. A node is also good if it has ever responded to one of our queries and has sent us a query within the last 15 minutes. After 15 minutes of inactivity, a node becomes questionable. Nodes become bad when they fail to respond to multiple queries in a row. Nodes that we know are good are given priority over nodes with unknown status.
The above informations have been readapted from [BitTorrent DHT protocol](http://www.bittorrent.org/beps/bep%5F0005.html)where more details can be found.

### Bye

This is an optional message used to inform the remote host that the connection is being closed and the reason for doing so.

## D

### Descriptor

The entity in which information is transmitted over the network. Same as _message_.

### DHT

Distributed Hash Table (DHT) is a _hash table_ distributed among Gnutella network nodes. Gtk-Gnutella uses an implementation of Kademlia for its DHT. Kademlia is also used for other p2p networks (such as eDonkey) but storing different keys and values, therere preventing inter-operability between DHT of different p2p networks. In Gnutella, DHT is used for exact lookups, alternate locations, push-proxies, etc. but not for keywords search. Operations such as _lookup, publish, store, etc._ are typically performed in a DHT whose nodes can be either active or passive.

## E

### EAR

_EAR_ stands for "Extra Acknowledgement Request".

## F

### Flow Control (FC) mode

Servents pile outgoing packets in a queue where they are broadcasted in a first-in-first-out (FIFO) mode. If outgoing bandwidth is small and many packets need to be broadcasted, the queue gets overloaded and the servent enters in _Flow Control (FC) mode_. While in FC mode all incoming queries on the connection are dropped. Of course servents should avoid entering FC mode by being granted more bandwidth or reducing the number of connected nodes.

### Flooding

_Flooding_ is a simple but inefficient P2P routing algorithm which sends messages to all the connected nodes in order to reach destination. The flooding algorithm have been replaced by the more efficient _GUESS_ algorithm.

## G

### G2 Hub

G2 Hubs in Gnutella2 network are equivalent to Ultrapeers in GnutellaNet. GTK-Gnutella usually connects to 2 G2 Hubs behaving as a leaf node on Gnutella2 network.

### GGEP

Gnutella Generic Extension Protocol (GGEP) includes new functions added to the original Gnutella 0.4 protocol: more informations [here](http://rfc-gnutella.sourceforge.net/src/GnutellaGenericExtensionProtocol.0.51.html).

### GIV

_GIV_ is the message sent by the servent that is going to send a file in response to a request.

### GnutellaNet

The GnutellaNet (or "Gnutella" in short) is an _overlay_ network. This means it is a network that sits on top of the normal internet. GnutellaNet is _unstructured_. This just means that no particular computer or group of computers controls GnutellaNet; it is probably more democratic than most governments.

As the GnutellaNet is an overlay network, it doesn't have to pay attention to geography. It is likely that you will connect to computers in other countries. Things might be faster if this was not the case. However, they may also be more resilient in the current form.

### GUESS (Gnutella UDP Extension for Scalable Searches)

As opposed to _flooding_ algorithm, with GUESS routing nodes are queried one at a time. Each node must keep a cache of known and trusted peers able to accept queries and the nodes are picked up randomly. This routing method is considered more efficient and safe compared to flooding.

### GUID (Global Unique IDentifier)

This is a 16-byte long value made of random bytes, whose purpose it is to identify servents and messages. This identification is not a signature, just a way to identify network entities in a unique manner.

## H

### HSEP

The Horizon Size Estimation Protocol (HSEP) refers to the estimation of the number of reachable resources within the Gnutella network, e.g. the number of reachable Gnutella nodes, shared files and shared kibibytes. More informations [here](http://www.schuerger.com/gnutella/hsep.html).

## L

### Leaf node

A leaf is the basic connection to the GnutellaNet. A leaf typically connects to three or four ultrapeers. The ultrapeers route searches and keep their leaves connected to the GnutellaNet.

## M

### Message

_Messages_ are the entity in which information is transmitted over the network. Synonyms are _packet_ and _descriptor_.

### MUID (Messages Unique IDentifier)

A _GUID_ for network messages.

## P

### PARQ (Passive/Active Remote Queuing)

When a servent asks for a file hosted by a servent having no free upload slots, the request enters a remote queue on the hosting sevent. This remote queue is handled by _PARQ_.

### Ping

A _Ping_ is a message sent by a servent trying to actively discover hosts on the network. A servent receiving a Ping message is expected to respond with one or more Pong messages.

### Pong

A _Pong_ is the response message to a Ping. It includes the address of a connected Gnutella servent, the listening port of that servent, and information regarding the amount of data it is making available to the network.

### Push

This is a mechanism that allows a firewalled servent to contribute file-based data to the network. For example a servent may send a Push message if it receives a QueryHit message from a servent that doesn't support incoming connections. This might occur when the servent sending the QueryHit message is behind a firewall.

### Push-proxy

A _push-proxy_ is a relaying node. If an ultrapeer is connected to the firewalled leaf, in order to send a _push_to that firewalled leaf, a servent can send an UDP message to the ultrapeer who will then relay it to the leaf. So the ultrapeer acts as the push-proxy: it is the relaying target to reach the leaf.

## Q

### QRP

Query Routing Protocol (QRP) is a scheme for avoiding broadcast queries on the Gnutella network. In this scheme, hosts create query route tables by hashing file keywords and regularly exchange them with their neighbors. Standard compression techniques minimize the cost of exchanging tables. This scheme can dramatically reduce Gnutella's bandwidth requirements improving scalability and leaving more bandwidth for files exchange.

### Query

Sending a _Query_ is the primary mechanism for searching the distributed network. A servent receiving a Query message will respond with a QueryHit if a match is found against its local data set.

### QueryHit

A _QueryHit_ is the response to a Query. This message provides the recipient with enough information to acquire the data matching the corresponding Query.

## R

### RUDP

The Reliable UDP (RUDP) protocol provides NAT-to-NAT transfers, sometimes called Firewall-to-Firewall or "hole-punching", in those cases where port-forwarding is not or cannot be done by the user.

### RX

RX stands for _Reception_, opposite of _Transmission_.

## S

### search literals

Double and single quotes can be used so that an entire search term will be matched instead of individual words. Quoting maybe necessary if you wish to search for a phrase with special characters such as the plus and minus signs (see "search requireds").

### search prefixes

1. browse: List shared files on the specified host. The format is "browse:_ip\_address:port_". Many portions of the GUI have a menu option, available from a right click, that will browser the specified computer.
2. http: Download the specified web page. This could be a zip file, a movie, large JPEG, etc.
3. local: Search results from the local host. Ie, your computer. A regular expression may follow to filter the results. For example, "local:manual" will show all files you share with manual in the file name.
4. magnet: Search and download the magnet target.
5. push: The format of this search is "push:_guid:ip\_address:port/path\_to\_file_". The _guid_ is the Gnutella ID of the computer that has the file of interest. The _ip:port_ is the push proxy that the _guid_ is connected to. Typically this would be an ultrapeer that will allow a proxy download. The _guid_ is a 32 hexadecimal characters.
6. sha1: A base64 SHA value to search for. It is not automatically downloaded.
7. urn: Similar to a sha1 search, but the hash value is specified. Ie, urn:sha1:_hash value_

### search requireds

Mini filters are created with the '+' and '-' signs. The plus sign requires that a word is part of the results. The minus sign doesn't display any results with the given phrase. The plus and minus signs can be used to select ambigious terms.

Suppose you wish to find information about apples. You might use a search like _apples -computers_. You may get even more relevant results by using _apples +fruit_.

### Servent

"Servent" word derives from the fusion of server+client. A node in a P2P network is called _servent_ because of the dual nature of both server and client.

### SOAP

Simple Object Access Protocol (SOAP) is a lightweight XML-based protocol for exchange of information in a decentralized, distributed environment like P2P networks. More informations [here](https://www.w3.org/TR/2000/NOTE-SOAP-20000508/).

## T

### THEX

The Tree Hash EXchange (THEX) format is used for exchanging Merkle Hash Trees built up from the subrange hashes of discrete digital files. More informations [here](http://adc.sourceforge.net/draft-jchapweske-thex-02.html).

### Time-To-Live (TTL)

TTL is the number of times a message will be forwarded by Gnutella servents before it is removed from the network. Each servent will decrement the TTL value before passing it on to another servent. When the TTL value reaches 0, the message will no longer be forwarded to avoid eccessive network traffic.

### TX

TX stands for _Transmission_.

## U

### Ultrapeer (UP)

An ultrapeer is well connected to the GnutellaNet. As ultrapeers must have many connections and route search queries, they require more resources than a leaf node. Ultrapeers will typically be connected to 30+ other ultrapeers and connected to 70+ leaf nodes.

## V

### Vendor Code

The Vendor Code is a conventional 4-letter code used in Query Hits to identify the software running the node that generated the hit. For gtk-gnutella the Vendor Code is _GTKG_.

---
